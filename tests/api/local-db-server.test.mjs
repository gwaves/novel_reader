import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

const serverPath = new URL('../../scripts/local-db-server.mjs', import.meta.url).pathname

describe('local database backup and restore API', () => {
  it('exports a complete SQLite backup containing the current library data', async () => {
    const context = await startLocalDbServer()
    try {
      await saveSampleState(context.baseUrl)

      const response = await fetch(`${context.baseUrl}/api/database/export`)
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('content-type')?.startsWith('application/vnd.sqlite3'), true)
      assert.match(response.headers.get('content-disposition') ?? '', /novel_reader-backup-.+\.sqlite/)

      const backupPath = join(context.tempDir, 'exported.sqlite')
      await writeBufferFile(backupPath, Buffer.from(await response.arrayBuffer()))

      const db = new DatabaseSync(backupPath, { readOnly: true })
      try {
        assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
        assert.equal(db.prepare('SELECT title FROM books WHERE id = ?').get('book-1').title, '测试小说')
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM chapters WHERE book_id = ?').get('book-1').count, 2)
        assert.equal(db.prepare('SELECT short FROM summaries WHERE chapter_id = ?').get('c1').short, '短概要')
      } finally {
        db.close()
      }
    } finally {
      await context.close()
    }
  })

  it('validates uploaded SQLite backups, creates a current backup, and stages restore for restart', async () => {
    const context = await startLocalDbServer()
    try {
      await saveSampleState(context.baseUrl)
      const exportResponse = await fetch(`${context.baseUrl}/api/database/export`)
      const validBackup = Buffer.from(await exportResponse.arrayBuffer())

      const response = await fetch(`${context.baseUrl}/api/database/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: validBackup,
      })
      const payload = await response.json()

      assert.equal(response.status, 200)
      assert.equal(payload.ok, true)
      assert.equal(payload.requiresRestart, true)
      assert.equal(existsSync(payload.backupPath), true)
      assert.equal(existsSync(payload.pendingRestorePath), true)
      assert.equal(payload.pendingRestorePath, join(context.tempDir, 'novel_reader.restore-pending.sqlite'))

      const staged = new DatabaseSync(payload.pendingRestorePath, { readOnly: true })
      try {
        assert.equal(staged.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
        assert.equal(staged.prepare('SELECT COUNT(*) AS count FROM books').get().count, 1)
      } finally {
        staged.close()
      }
    } finally {
      await context.close()
    }
  })

  it('rejects invalid SQLite restore uploads without staging a pending restore', async () => {
    const context = await startLocalDbServer()
    try {
      await saveSampleState(context.baseUrl)

      const response = await fetch(`${context.baseUrl}/api/database/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: Buffer.from('this is not a sqlite database'),
      })
      const payload = await response.json()

      assert.equal(response.status, 400)
      assert.match(payload.error, /file is not a database|not a database|SQLite|database/i)
      assert.equal(existsSync(join(context.tempDir, 'novel_reader.restore-pending.sqlite')), false)

      const stateResponse = await fetch(`${context.baseUrl}/api/state`)
      const statePayload = await stateResponse.json()
      assert.equal(statePayload.state.books[0].book.title, '测试小说')
    } finally {
      await context.close()
    }
  })
})

describe('local knowledge graph integrity API', () => {
  it('deletes an entity and cascades connected mentions and relations without orphan references', async () => {
    const context = await startLocalDbServer()
    try {
      await saveSampleState(context.baseUrl)
      await saveSampleKgExtraction(context.baseUrl)

      const entitiesBefore = await fetchJson(`${context.baseUrl}/api/kg/entities?bookId=book-1`)
      const source = entitiesBefore.entities.find((entity) => entity.name === '林青')
      assert.ok(source)

      const deleteResponse = await fetch(`${context.baseUrl}/api/kg/entities/${encodeURIComponent(source.id)}`, {
        method: 'DELETE',
      })
      assert.equal(deleteResponse.status, 200)

      const deletedDetail = await fetch(`${context.baseUrl}/api/kg/entities/${encodeURIComponent(source.id)}`)
      assert.equal(deletedDetail.status, 404)

      const entitiesAfter = await fetchJson(`${context.baseUrl}/api/kg/entities?bookId=book-1`)
      assert.deepEqual(
        entitiesAfter.entities.map((entity) => entity.name).sort(),
        ['白衣客', '阿梨', '青州'].sort(),
      )

      const relationsAfter = await fetchJson(`${context.baseUrl}/api/kg/relations?bookId=book-1`)
      assert.equal(relationsAfter.relations.length, 1)
      assert.equal(relationsAfter.relations[0].sourceName, '阿梨')
      assert.equal(relationsAfter.relations[0].targetName, '青州')

      const db = new DatabaseSync(join(context.tempDir, 'novel_reader.sqlite'), { readOnly: true })
      try {
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM kg_entity_mentions WHERE entity_id = ?').get(source.id).count, 0)
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM kg_relations WHERE source_entity_id = ? OR target_entity_id = ?').get(source.id, source.id).count, 0)
        assert.equal(db.prepare(`
          SELECT COUNT(*) AS count
          FROM kg_entity_mentions mention
          LEFT JOIN kg_entities entity ON entity.id = mention.entity_id
          WHERE entity.id IS NULL
        `).get().count, 0)
        assert.equal(db.prepare(`
          SELECT COUNT(*) AS count
          FROM kg_relation_mentions mention
          LEFT JOIN kg_relations relation ON relation.id = mention.relation_id
          WHERE relation.id IS NULL
        `).get().count, 0)
        assert.equal(db.prepare(`
          SELECT COUNT(*) AS count
          FROM kg_relations relation
          LEFT JOIN kg_entities source ON source.id = relation.source_entity_id
          LEFT JOIN kg_entities target ON target.id = relation.target_entity_id
          WHERE source.id IS NULL OR target.id IS NULL
        `).get().count, 0)
      } finally {
        db.close()
      }
    } finally {
      await context.close()
    }
  })

  it('rejects invalid relation endpoint edits and merges evidence when endpoint edits conflict', async () => {
    const context = await startLocalDbServer()
    try {
      await saveSampleState(context.baseUrl, sampleState({ includeSecondBook: true }))
      await saveSampleKgExtraction(context.baseUrl)
      await saveSecondBookKgExtraction(context.baseUrl)

      const bookOneEntities = await fetchJson(`${context.baseUrl}/api/kg/entities?bookId=book-1`)
      const bookTwoEntities = await fetchJson(`${context.baseUrl}/api/kg/entities?bookId=book-2`)
      const linQing = bookOneEntities.entities.find((entity) => entity.name === '林青')
      const whiteGuest = bookOneEntities.entities.find((entity) => entity.name === '白衣客')
      const ali = bookOneEntities.entities.find((entity) => entity.name === '阿梨')
      const qingzhou = bookOneEntities.entities.find((entity) => entity.name === '青州')
      const otherBookEntity = bookTwoEntities.entities.find((entity) => entity.name === '韩立')
      assert.ok(linQing)
      assert.ok(whiteGuest)
      assert.ok(ali)
      assert.ok(qingzhou)
      assert.ok(otherBookEntity)

      const relationsBefore = await fetchJson(`${context.baseUrl}/api/kg/relations?bookId=book-1`)
      const relationToMove = relationsBefore.relations.find((relation) => relation.sourceName === '林青' && relation.targetName === '白衣客')
      const existingConflict = relationsBefore.relations.find((relation) => relation.sourceName === '阿梨' && relation.targetName === '青州')
      assert.ok(relationToMove)
      assert.ok(existingConflict)

      const selfLoopResponse = await updateRelation(context.baseUrl, relationToMove.id, {
        sourceId: linQing.id,
        targetId: linQing.id,
        type: relationToMove.type,
        description: relationToMove.description ?? '',
      })
      assert.equal(selfLoopResponse.status, 400)
      assert.match((await selfLoopResponse.json()).error, /不能相同/)

      const crossBookResponse = await updateRelation(context.baseUrl, relationToMove.id, {
        sourceId: linQing.id,
        targetId: otherBookEntity.id,
        type: relationToMove.type,
        description: relationToMove.description ?? '',
      })
      assert.equal(crossBookResponse.status, 400)
      assert.match((await crossBookResponse.json()).error, /同一本书/)

      const conflictResponse = await updateRelation(context.baseUrl, relationToMove.id, {
        sourceId: ali.id,
        targetId: qingzhou.id,
        type: existingConflict.type,
        description: '编辑后与既有关系冲突，应合并证据',
      })
      assert.equal(conflictResponse.status, 200)
      const conflictPayload = await conflictResponse.json()
      assert.equal(conflictPayload.relation.id, existingConflict.id)

      const oldRelationResponse = await fetch(`${context.baseUrl}/api/kg/relations/${encodeURIComponent(relationToMove.id)}`)
      assert.equal(oldRelationResponse.status, 404)

      const mergedRelation = await fetchJson(`${context.baseUrl}/api/kg/relations/${encodeURIComponent(existingConflict.id)}`)
      assert.equal(mergedRelation.mentions.length, 2)
      assert.deepEqual(
        mergedRelation.mentions.map((mention) => mention.evidence).sort(),
        ['林青遇见白衣客', '阿梨在青州等候'].sort(),
      )

      const relationsAfter = await fetchJson(`${context.baseUrl}/api/kg/relations?bookId=book-1`)
      assert.equal(relationsAfter.relations.length, 1)
      assert.equal(relationsAfter.relations[0].id, existingConflict.id)

      assert.equal(await countOrphanGraphRows(context.tempDir), 0)
    } finally {
      await context.close()
    }
  })

  it('merges entity aliases, mentions, and relations without orphan references', async () => {
    const context = await startLocalDbServer()
    try {
      await saveSampleState(context.baseUrl)
      await saveSampleKgExtraction(context.baseUrl)
      await saveSecondChapterMergeKgExtraction(context.baseUrl)

      const entitiesBefore = await fetchJson(`${context.baseUrl}/api/kg/entities?bookId=book-1`)
      const source = entitiesBefore.entities.find((entity) => entity.name === '少年林青')
      const target = entitiesBefore.entities.find((entity) => entity.name === '林青')
      assert.ok(source)
      assert.ok(target)

      const mergeResponse = await fetch(`${context.baseUrl}/api/kg/entities/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId: source.id, targetId: target.id }),
      })
      assert.equal(mergeResponse.status, 200)
      const mergePayload = await mergeResponse.json()
      assert.equal(mergePayload.entity.id, target.id)
      assert.equal(mergePayload.sourceName, '少年林青')
      assert.equal(mergePayload.entity.aliases.includes('少年林青'), true)
      assert.equal(mergePayload.entity.aliases.includes('青衣少年'), true)

      const sourceDetail = await fetch(`${context.baseUrl}/api/kg/entities/${encodeURIComponent(source.id)}`)
      assert.equal(sourceDetail.status, 404)

      const targetDetail = await fetchJson(`${context.baseUrl}/api/kg/entities/${encodeURIComponent(target.id)}`)
      assert.deepEqual(
        targetDetail.mentions.map((mention) => mention.chapterId).sort(),
        ['c1', 'c2'],
      )
      assert.equal(
        targetDetail.relations.some((relation) => relation.sourceName === '林青' && relation.targetName === '白衣客'),
        true,
      )

      const relationsAfter = await fetchJson(`${context.baseUrl}/api/kg/relations?bookId=book-1`)
      const mergedRelation = relationsAfter.relations.find((relation) => relation.sourceName === '林青' && relation.targetName === '白衣客')
      assert.ok(mergedRelation)
      const mergedRelationDetail = await fetchJson(`${context.baseUrl}/api/kg/relations/${encodeURIComponent(mergedRelation.id)}`)
      assert.deepEqual(
        mergedRelationDetail.mentions.map((mention) => mention.chapterId).sort(),
        ['c1', 'c2'],
      )

      assert.equal(await countOrphanGraphRows(context.tempDir), 0)
    } finally {
      await context.close()
    }
  })

  it('splits selected aliases, mentions, and relations into a new entity without orphan references', async () => {
    const context = await startLocalDbServer()
    try {
      await saveSampleState(context.baseUrl)
      await saveSplitKgExtractions(context.baseUrl)

      const entitiesBefore = await fetchJson(`${context.baseUrl}/api/kg/entities?bookId=book-1`)
      const source = entitiesBefore.entities.find((entity) => entity.name === '林青')
      assert.ok(source)

      const sourceDetailBefore = await fetchJson(`${context.baseUrl}/api/kg/entities/${encodeURIComponent(source.id)}`)
      assert.deepEqual(
        sourceDetailBefore.mentions.map((mention) => mention.chapterId).sort(),
        ['c1', 'c2'],
      )
      assert.equal(sourceDetailBefore.entity.aliases.includes('青衣少年'), true)

      const mentionToMove = sourceDetailBefore.mentions.find((mention) => mention.chapterId === 'c2')
      const relationToMove = sourceDetailBefore.relations.find(
        (relation) => relation.sourceName === '林青' && relation.targetName === '白衣客',
      )
      assert.ok(mentionToMove)
      assert.ok(relationToMove)

      const splitResponse = await fetch(`${context.baseUrl}/api/kg/entities/${encodeURIComponent(source.id)}/split`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: '青衣少年',
          type: 'person',
          aliases: ['山村少年'],
          description: '从林青实体中拆出的第二章身份。',
          movedAliases: ['青衣少年'],
          mentionIds: [mentionToMove.id],
          relationIds: [relationToMove.id],
        }),
      })
      assert.equal(splitResponse.status, 200)
      const splitPayload = await splitResponse.json()
      assert.equal(splitPayload.source.id, source.id)
      assert.equal(splitPayload.source.aliases.includes('青衣少年'), false)
      assert.equal(splitPayload.target.name, '青衣少年')
      assert.equal(splitPayload.target.aliases.includes('山村少年'), true)

      const sourceDetailAfter = await fetchJson(`${context.baseUrl}/api/kg/entities/${encodeURIComponent(source.id)}`)
      assert.deepEqual(sourceDetailAfter.mentions.map((mention) => mention.chapterId), ['c1'])
      assert.equal(sourceDetailAfter.entity.firstChapterIndex, 1)
      assert.equal(sourceDetailAfter.entity.lastChapterIndex, 1)
      assert.equal(sourceDetailAfter.relations.length, 0)

      const targetDetail = await fetchJson(`${context.baseUrl}/api/kg/entities/${encodeURIComponent(splitPayload.target.id)}`)
      assert.deepEqual(targetDetail.mentions.map((mention) => mention.chapterId), ['c2'])
      assert.equal(targetDetail.entity.firstChapterIndex, 2)
      assert.equal(targetDetail.entity.lastChapterIndex, 2)
      assert.equal(targetDetail.entity.aliases.includes('青衣少年'), false)
      assert.equal(targetDetail.entity.aliases.includes('山村少年'), true)
      assert.equal(targetDetail.relations.length, 1)
      assert.equal(targetDetail.relations[0].sourceName, '青衣少年')
      assert.equal(targetDetail.relations[0].targetName, '白衣客')

      const movedRelationDetail = await fetchJson(`${context.baseUrl}/api/kg/relations/${encodeURIComponent(relationToMove.id)}`)
      assert.equal(movedRelationDetail.relation.sourceName, '青衣少年')
      assert.equal(movedRelationDetail.relation.targetName, '白衣客')
      assert.equal(movedRelationDetail.relation.firstChapterIndex, 1)
      assert.equal(movedRelationDetail.relation.lastChapterIndex, 2)
      assert.deepEqual(
        movedRelationDetail.mentions.map((mention) => mention.chapterId).sort(),
        ['c1', 'c2'],
      )
      assert.deepEqual(
        movedRelationDetail.mentions.map((mention) => mention.evidence).sort(),
        ['林青初遇白衣客', '青衣少年再见白衣客'].sort(),
      )

      assert.equal(await countOrphanGraphRows(context.tempDir), 0)
    } finally {
      await context.close()
    }
  })

  it('marks, ignores, and deletes review queue items in batches without orphan references', async () => {
    const context = await startLocalDbServer()
    try {
      await saveSampleState(context.baseUrl)
      await saveReviewQueueKgExtraction(context.baseUrl)

      const initialQueue = await fetchJson(`${context.baseUrl}/api/kg/review-queue?bookId=book-1&kind=all`)
      const entityToApprove = initialQueue.entities.find((entity) => entity.name === '青州')
      const entityToDelete = initialQueue.entities.find((entity) => entity.name === '影')
      const relationToIgnore = initialQueue.relations.find((relation) => relation.sourceName === '林青' && relation.targetName === '白衣客')
      const relationToDelete = initialQueue.relations.find((relation) => relation.sourceName === '阿梨' && relation.targetName === '青州')
      assert.ok(entityToApprove)
      assert.ok(entityToDelete)
      assert.ok(relationToIgnore)
      assert.ok(relationToDelete)
      assert.equal(entityToApprove.reasons.includes('single_mention'), true)
      assert.equal(entityToDelete.reasons.includes('name_too_short'), true)
      assert.equal(relationToIgnore.reasons.includes('description_missing'), true)
      assert.equal(relationToDelete.reasons.includes('confidence_low'), true)

      const markEntityResponse = await markReviewItems(context.baseUrl, 'entities', 'approved', [entityToApprove.id])
      assert.equal(markEntityResponse.status, 200)
      assert.deepEqual(await markEntityResponse.json(), { marked: 1 })

      const markRelationResponse = await markReviewItems(context.baseUrl, 'relations', 'ignored', [relationToIgnore.id])
      assert.equal(markRelationResponse.status, 200)
      assert.deepEqual(await markRelationResponse.json(), { marked: 1 })

      const queueAfterMark = await fetchJson(`${context.baseUrl}/api/kg/review-queue?bookId=book-1&kind=all`)
      assert.equal(queueAfterMark.entities.some((entity) => entity.id === entityToApprove.id), false)
      assert.equal(queueAfterMark.relations.some((relation) => relation.id === relationToIgnore.id), false)
      assert.equal(queueAfterMark.entities.some((entity) => entity.id === entityToDelete.id), true)
      assert.equal(queueAfterMark.relations.some((relation) => relation.id === relationToDelete.id), true)

      const approvedEntityDetail = await fetch(`${context.baseUrl}/api/kg/entities/${encodeURIComponent(entityToApprove.id)}`)
      const ignoredRelationDetail = await fetch(`${context.baseUrl}/api/kg/relations/${encodeURIComponent(relationToIgnore.id)}`)
      assert.equal(approvedEntityDetail.status, 200)
      assert.equal(ignoredRelationDetail.status, 200)

      const deleteRelationResponse = await deleteReviewItems(context.baseUrl, 'relations', [relationToDelete.id])
      assert.equal(deleteRelationResponse.status, 200)
      assert.deepEqual(await deleteRelationResponse.json(), { deleted: 1 })
      const deletedRelationDetail = await fetch(`${context.baseUrl}/api/kg/relations/${encodeURIComponent(relationToDelete.id)}`)
      assert.equal(deletedRelationDetail.status, 404)

      const deleteEntityResponse = await deleteReviewItems(context.baseUrl, 'entities', [entityToDelete.id])
      assert.equal(deleteEntityResponse.status, 200)
      assert.deepEqual(await deleteEntityResponse.json(), { deleted: 1 })
      const deletedEntityDetail = await fetch(`${context.baseUrl}/api/kg/entities/${encodeURIComponent(entityToDelete.id)}`)
      assert.equal(deletedEntityDetail.status, 404)

      assert.equal(await countOrphanGraphRows(context.tempDir), 0)

      const db = new DatabaseSync(join(context.tempDir, 'novel_reader.sqlite'), { readOnly: true })
      try {
        assert.equal(db.prepare('SELECT review_status AS status FROM kg_entities WHERE id = ?').get(entityToApprove.id).status, 'approved')
        assert.equal(db.prepare('SELECT review_status AS status FROM kg_relations WHERE id = ?').get(relationToIgnore.id).status, 'ignored')
      } finally {
        db.close()
      }
    } finally {
      await context.close()
    }
  })

  it('previews overwrite scan diffs without writing graph changes until extraction is applied', async () => {
    const context = await startLocalDbServer()
    try {
      await saveSampleState(context.baseUrl)
      await saveDiffPreviewInitialExtraction(context.baseUrl)

      const entitiesBefore = await fetchJson(`${context.baseUrl}/api/kg/entities?bookId=book-1`)
      const relationsBefore = await fetchJson(`${context.baseUrl}/api/kg/relations?bookId=book-1`)
      const savedBefore = await fetchJson(`${context.baseUrl}/api/kg/chapters/c1/extraction`)
      assert.deepEqual(
        entitiesBefore.entities.map((entity) => entity.name).sort(),
        ['林青', '白衣客', '阿梨', '青州'].sort(),
      )
      assert.deepEqual(
        relationsBefore.relations.map((relation) => `${relation.sourceName}->${relation.targetName}:${relation.type}`).sort(),
        ['林青->白衣客:knows', '阿梨->青州:located_in'].sort(),
      )
      assert.equal(savedBefore.extraction.model, 'initial-model')

      const nextExtraction = diffPreviewReplacementExtraction()
      const diffResponse = await fetch(`${context.baseUrl}/api/kg/chapters/c1/extraction/diff`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookId: 'book-1', extraction: nextExtraction }),
      })
      assert.equal(diffResponse.status, 200)
      const diffPayload = await diffResponse.json()
      assert.deepEqual(diffPayload.summary, {
        entitiesAdded: 1,
        entitiesRemoved: 2,
        entitiesUnchanged: 2,
        relationsAdded: 1,
        relationsRemoved: 1,
        relationsUnchanged: 1,
      })
      assert.deepEqual(diffPayload.entities.added.map((entity) => entity.name), ['夜枭'])
      assert.deepEqual(diffPayload.entities.removed.map((entity) => entity.name).sort(), ['阿梨', '青州'].sort())
      assert.deepEqual(diffPayload.relations.added.map((relation) => `${relation.sourceName}->${relation.targetName}:${relation.type}`), ['夜枭->林青:enemy_of'])
      assert.deepEqual(diffPayload.relations.removed.map((relation) => `${relation.sourceName}->${relation.targetName}:${relation.type}`), ['阿梨->青州:located_in'])

      const entitiesAfterPreview = await fetchJson(`${context.baseUrl}/api/kg/entities?bookId=book-1`)
      const relationsAfterPreview = await fetchJson(`${context.baseUrl}/api/kg/relations?bookId=book-1`)
      const savedAfterPreview = await fetchJson(`${context.baseUrl}/api/kg/chapters/c1/extraction`)
      assert.deepEqual(
        entitiesAfterPreview.entities.map((entity) => entity.name).sort(),
        entitiesBefore.entities.map((entity) => entity.name).sort(),
      )
      assert.deepEqual(
        relationsAfterPreview.relations.map((relation) => `${relation.sourceName}->${relation.targetName}:${relation.type}`).sort(),
        relationsBefore.relations.map((relation) => `${relation.sourceName}->${relation.targetName}:${relation.type}`).sort(),
      )
      assert.deepEqual(savedAfterPreview.extraction.extraction, savedBefore.extraction.extraction)
      assert.equal(savedAfterPreview.extraction.model, 'initial-model')

      const applyResponse = await fetch(`${context.baseUrl}/api/kg/chapters/c1/extraction`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookId: 'book-1', model: 'replacement-model', extraction: nextExtraction }),
      })
      assert.equal(applyResponse.status, 200)

      const entitiesAfterApply = await fetchJson(`${context.baseUrl}/api/kg/entities?bookId=book-1`)
      const relationsAfterApply = await fetchJson(`${context.baseUrl}/api/kg/relations?bookId=book-1`)
      const savedAfterApply = await fetchJson(`${context.baseUrl}/api/kg/chapters/c1/extraction`)
      assert.deepEqual(
        entitiesAfterApply.entities.map((entity) => entity.name).sort(),
        ['林青', '白衣客', '夜枭'].sort(),
      )
      assert.deepEqual(
        relationsAfterApply.relations.map((relation) => `${relation.sourceName}->${relation.targetName}:${relation.type}`).sort(),
        ['林青->白衣客:knows', '夜枭->林青:enemy_of'].sort(),
      )
      assert.deepEqual(savedAfterApply.extraction.extraction, nextExtraction)
      assert.equal(savedAfterApply.extraction.model, 'replacement-model')
      assert.equal(await countOrphanGraphRows(context.tempDir), 0)
    } finally {
      await context.close()
    }
  })

  it('replays saved raw KG extraction JSON to rebuild a chapter graph without calling a model', async () => {
    const context = await startLocalDbServer()
    try {
      await saveSampleState(context.baseUrl)
      await saveDiffPreviewInitialExtraction(context.baseUrl)

      const saved = await fetchJson(`${context.baseUrl}/api/kg/chapters/c1/extraction`)
      assert.equal(saved.extraction.model, 'initial-model')
      assert.deepEqual(
        saved.extraction.extraction.entities.map((entity) => entity.name).sort(),
        ['林青', '白衣客', '阿梨', '青州'].sort(),
      )

      const entitiesBeforeDelete = await fetchJson(`${context.baseUrl}/api/kg/entities?bookId=book-1`)
      const linQing = entitiesBeforeDelete.entities.find((entity) => entity.name === '林青')
      assert.ok(linQing)

      const deleteResponse = await fetch(`${context.baseUrl}/api/kg/entities/${encodeURIComponent(linQing.id)}`, {
        method: 'DELETE',
      })
      assert.equal(deleteResponse.status, 200)

      const entitiesAfterDelete = await fetchJson(`${context.baseUrl}/api/kg/entities?bookId=book-1`)
      const relationsAfterDelete = await fetchJson(`${context.baseUrl}/api/kg/relations?bookId=book-1`)
      assert.deepEqual(
        entitiesAfterDelete.entities.map((entity) => entity.name).sort(),
        ['白衣客', '阿梨', '青州'].sort(),
      )
      assert.deepEqual(
        relationsAfterDelete.relations.map((relation) => `${relation.sourceName}->${relation.targetName}:${relation.type}`).sort(),
        ['阿梨->青州:located_in'],
      )

      const replayResponse = await fetch(`${context.baseUrl}/api/kg/chapters/c1/extraction`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bookId: saved.extraction.bookId,
          model: 'replayed-from-saved-json',
          extraction: saved.extraction.extraction,
        }),
      })
      assert.equal(replayResponse.status, 200)

      const entitiesAfterReplay = await fetchJson(`${context.baseUrl}/api/kg/entities?bookId=book-1`)
      const relationsAfterReplay = await fetchJson(`${context.baseUrl}/api/kg/relations?bookId=book-1`)
      const savedAfterReplay = await fetchJson(`${context.baseUrl}/api/kg/chapters/c1/extraction`)
      assert.deepEqual(
        entitiesAfterReplay.entities.map((entity) => entity.name).sort(),
        ['林青', '白衣客', '阿梨', '青州'].sort(),
      )
      assert.deepEqual(
        relationsAfterReplay.relations.map((relation) => `${relation.sourceName}->${relation.targetName}:${relation.type}`).sort(),
        ['林青->白衣客:knows', '阿梨->青州:located_in'].sort(),
      )
      assert.deepEqual(savedAfterReplay.extraction.extraction, saved.extraction.extraction)
      assert.equal(savedAfterReplay.extraction.model, 'replayed-from-saved-json')
      assert.equal(await countOrphanGraphRows(context.tempDir), 0)
    } finally {
      await context.close()
    }
  })

  it('builds coreference candidate components from shared non-generic aliases only', async () => {
    const context = await startLocalDbServer()
    try {
      await saveSampleState(context.baseUrl)
      await saveCoreferenceKgExtractions(context.baseUrl)

      const components = await fetchJson(`${context.baseUrl}/api/kg/coreference/components?bookId=book-1`)
      assert.equal(components.totalComponents, 1)
      assert.deepEqual(
        components.components.map((component) => component.map((entity) => entity.name).sort()),
        [['南宫婉', '精灵少女'].sort()],
      )

      const candidate = components.components[0]
      const canonical = candidate.find((entity) => entity.name === '南宫婉')
      const aliasNode = candidate.find((entity) => entity.name === '精灵少女')
      assert.ok(canonical)
      assert.ok(aliasNode)
      assert.equal(canonical.aliases.includes('精灵少女'), true)
      assert.equal(aliasNode.aliases.includes('南宫婉'), true)
      assert.equal(candidate.some((entity) => ['韩立', '掩月宗'].includes(entity.name)), false)
    } finally {
      await context.close()
    }
  })

  it('resolves coreference with a mocked LLM and merges only confirmed identity clusters', async () => {
    const context = await startLocalDbServer()
    const llm = await startMockOpenAiChatServer({
      clusters: [
        {
          canonical_name: '南宫婉',
          members: ['南宫婉', '精灵少女'],
          confidence: 0.97,
          reason: '精灵少女是南宫婉早期身份。',
        },
      ],
    })
    try {
      await saveSampleState(context.baseUrl)
      await saveCoreferenceKgExtractions(context.baseUrl)

      const components = await fetchJson(`${context.baseUrl}/api/kg/coreference/components?bookId=book-1`)
      assert.equal(components.totalComponents, 1)
      assert.deepEqual(
        components.components[0].map((entity) => entity.name).sort(),
        ['南宫婉', '精灵少女'].sort(),
      )

      const resolveResponse = await fetch(`${context.baseUrl}/api/kg/coreference/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bookId: 'book-1',
          provider: 'openai',
          model: 'mock-coref',
          baseUrl: llm.baseUrl,
          apiKey: 'test-key',
          limit: 1,
          concurrency: 1,
          jsonMode: true,
          thinkingEnabled: false,
        }),
      })
      assert.equal(resolveResponse.status, 202)
      const resolvePayload = await resolveResponse.json()
      assert.equal(resolvePayload.totalComponents, 1)
      assert.equal(resolvePayload.processedThisRun, 1)
      assert.equal(resolvePayload.hasMore, false)

      const job = await waitForKgJob(context.baseUrl, 'book-1', resolvePayload.jobId)
      assert.equal(job.status, 'completed')
      assert.equal(job.completedChapters, 1)
      assert.equal(job.failedChapters, 0)
      assert.equal(llm.requests.length, 1)
      assert.equal(llm.requests[0].headers.authorization, 'Bearer test-key')
      assert.equal(llm.requests[0].body.response_format.type, 'json_object')
      assert.match(llm.requests[0].body.messages.at(-1).content, /南宫婉/)
      assert.match(llm.requests[0].body.messages.at(-1).content, /精灵少女/)

      const entitiesAfter = await fetchJson(`${context.baseUrl}/api/kg/entities?bookId=book-1`)
      assert.deepEqual(
        entitiesAfter.entities.map((entity) => entity.name).sort(),
        ['南宫婉', '掩月宗', '韩立'].sort(),
      )
      const canonical = entitiesAfter.entities.find((entity) => entity.name === '南宫婉')
      const hanLi = entitiesAfter.entities.find((entity) => entity.name === '韩立')
      assert.ok(canonical)
      assert.ok(hanLi)

      const canonicalDetail = await fetchJson(`${context.baseUrl}/api/kg/entities/${encodeURIComponent(canonical.id)}`)
      assert.equal(canonicalDetail.entity.aliases.includes('精灵少女'), true)
      assert.deepEqual(canonicalDetail.mentions.map((mention) => mention.chapterId).sort(), ['c1', 'c2'])

      const relationsAfter = await fetchJson(`${context.baseUrl}/api/kg/relations?bookId=book-1`)
      const relationLabels = relationsAfter.relations.map((relation) => `${relation.sourceName}->${relation.targetName}:${relation.type}`).sort()
      assert.deepEqual(relationLabels, ['南宫婉->掩月宗:member_of', '韩立->掩月宗:member_of'].sort())

      const mergedRelation = relationsAfter.relations.find((relation) => relation.sourceName === '南宫婉')
      assert.ok(mergedRelation)
      assert.equal(mergedRelation.mentionCount, 2)
      const mergedRelationDetail = await fetchJson(`${context.baseUrl}/api/kg/relations/${encodeURIComponent(mergedRelation.id)}`)
      assert.deepEqual(mergedRelationDetail.mentions.map((mention) => mention.chapterId).sort(), ['c1', 'c2'])

      assert.equal(await countOrphanGraphRows(context.tempDir), 0)
    } finally {
      await llm.close()
      await context.close()
    }
  })
})

describe('local RAG search readiness API', () => {
  it('generates summary and chunk embeddings with the configured embedding provider', async () => {
    const context = await startLocalDbServer()
    const embeddings = await startMockEmbeddingServer()
    try {
      const state = sampleState()
      state.books[0].summaries.c2 = {
        short: '第二章短概要',
        detail: '第二章详细概要',
        keyPoints: ['第二章要点'],
        skippable: '不可跳读',
        generatedBy: 'local',
      }
      await saveSampleState(context.baseUrl, state)

      const response = await fetch(`${context.baseUrl}/api/rag/embeddings/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bookId: 'book-1',
          provider: 'openai',
          model: 'mock-embedding',
          baseUrl: embeddings.baseUrl,
          concurrency: 2,
        }),
      })
      const payload = await response.json()

      assert.equal(response.status, 200)
      assert.equal(payload.completed, 2)
      assert.equal(payload.failed, 0)
      assert.equal(payload.total, 2)
      assert.equal(payload.chunkCompleted, 2)
      assert.equal(payload.chunkFailed, 0)
      assert.equal(embeddings.requests.length, 4)
      assert.deepEqual(
        embeddings.requests.map((request) => request.body.model),
        ['mock-embedding', 'mock-embedding', 'mock-embedding', 'mock-embedding'],
      )

      const status = await fetchJson(
        `${context.baseUrl}/api/rag/embeddings/status?bookId=${encodeURIComponent('book-1')}&model=${encodeURIComponent('mock-embedding')}`,
      )
      assert.equal(status.totalChapters, 2)
      assert.equal(status.summarizedChapters, 2)
      assert.equal(status.embeddedChapters, 2)
      assert.equal(status.missingChapters, 0)
      assert.equal(status.totalChunks, 2)
      assert.equal(status.embeddedChunks, 2)
      assert.equal(status.missingChunks, 0)
      assert.equal(status.dimension, 3)

      const db = new DatabaseSync(join(context.tempDir, 'novel_reader.sqlite'), { readOnly: true })
      try {
        assert.equal(
          db.prepare('SELECT COUNT(*) AS count FROM summary_embeddings WHERE book_id = ? AND model = ? AND dimension = ?').get('book-1', 'mock-embedding', 3).count,
          2,
        )
        assert.equal(
          db.prepare('SELECT COUNT(*) AS count FROM chapter_chunk_embeddings WHERE book_id = ? AND model = ? AND dimension = ?').get('book-1', 'mock-embedding', 3).count,
          2,
        )
      } finally {
        db.close()
      }
    } finally {
      await embeddings.close()
      await context.close()
    }
  })

  it('blocks RAG search when summary embedding coverage is insufficient without calling the embedding provider', async () => {
    const context = await startLocalDbServer()
    const embeddings = await startMockEmbeddingServer()
    try {
      await saveSampleState(context.baseUrl)

      const response = await fetch(`${context.baseUrl}/api/rag/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bookId: 'book-1',
          query: '林青遇见了谁',
          provider: 'openai',
          model: 'mock-embedding',
          baseUrl: embeddings.baseUrl,
          topK: 5,
          includeSnippets: true,
        }),
      })
      const payload = await response.json()

      assert.equal(response.status, 409)
      assert.equal(payload.code, 'EMBEDDINGS_NOT_READY')
      assert.equal(payload.embeddedCount, 0)
      assert.equal(payload.totalChapters, 2)
      assert.match(payload.error, /0\/2 chapters embedded/)
      assert.equal(embeddings.requests.length, 0)
    } finally {
      await embeddings.close()
      await context.close()
    }
  })

  it('enriches RAG search results with graph entity matches resolved from aliases', async () => {
    const context = await startLocalDbServer()
    const embeddings = await startMockEmbeddingServer()
    try {
      const state = sampleState()
      state.books[0].summaries.c2 = {
        short: '第二章短概要',
        detail: '第二章详细概要',
        keyPoints: ['第二章要点'],
        skippable: '不可跳读',
        generatedBy: 'local',
      }
      await saveSampleState(context.baseUrl, state)
      await saveSampleKgExtraction(context.baseUrl)

      const embeddingResponse = await fetch(`${context.baseUrl}/api/rag/embeddings/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bookId: 'book-1',
          provider: 'openai',
          model: 'mock-embedding',
          baseUrl: embeddings.baseUrl,
          force: true,
          concurrency: 2,
        }),
      })
      const embeddingPayload = await embeddingResponse.json()
      assert.equal(embeddingResponse.status, 200)
      assert.equal(embeddingPayload.completed, 2)
      assert.equal(embeddingPayload.failed, 0)

      const searchResponse = await fetch(`${context.baseUrl}/api/rag/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bookId: 'book-1',
          query: '少年林青第一次遇见了谁',
          provider: 'openai',
          model: 'mock-embedding',
          baseUrl: embeddings.baseUrl,
          topK: 2,
          includeSnippets: true,
        }),
      })
      const payload = await searchResponse.json()

      assert.equal(searchResponse.status, 200)
      assert.equal(payload.entityMatches.length, 1)
      assert.equal(payload.entityMatches[0].entityName, '林青')
      assert.deepEqual(payload.entityMatches[0].aliases, ['少年林青'])

      const firstChapter = payload.results.find((result) => result.chapterId === 'c1')
      assert.ok(firstChapter)
      assert.equal(firstChapter.chapterIndex, 1)
      assert.match(firstChapter.matchType, /both|entity|entity-first/)
      assert.deepEqual(firstChapter.matchedEntities, ['林青'])
      assert.match(firstChapter.contentSnippet, /第一章正文/)
      assert.ok(embeddings.requests.length > 0)
    } finally {
      await embeddings.close()
      await context.close()
    }
  })
})

async function startLocalDbServer() {
  const tempDir = await mkdtemp(join(tmpdir(), 'novel-reader-local-db-test-'))
  const port = await freePort()
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      NOVEL_READER_API_HOST: '127.0.0.1',
      NOVEL_READER_API_PORT: String(port),
      NOVEL_READER_DATA_DIR: tempDir,
      NOVEL_READER_DB_PATH: join(tempDir, 'novel_reader.sqlite'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const output = []
  child.stdout.on('data', (chunk) => output.push(chunk.toString()))
  child.stderr.on('data', (chunk) => output.push(chunk.toString()))

  const baseUrl = `http://127.0.0.1:${port}`
  await waitForServer(baseUrl, child, output)

  return {
    baseUrl,
    tempDir,
    close: async () => {
      child.kill('SIGTERM')
      await new Promise((resolve) => child.once('exit', resolve))
      await rm(tempDir, { recursive: true, force: true })
    },
  }
}

async function waitForServer(baseUrl, child, output) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 10_000) {
    if (child.exitCode != null) {
      throw new Error(`local-db-server exited early:\n${output.join('')}`)
    }
    try {
      const response = await fetch(`${baseUrl}/api/storage`)
      if (response.ok) return
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out waiting for local-db-server:\n${output.join('')}`)
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolve(address.port))
    })
    server.on('error', reject)
  })
}

async function saveSampleState(baseUrl, state = sampleState()) {
  const response = await fetch(`${baseUrl}/api/state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state }),
  })
  assert.equal(response.status, 200)
}

async function saveSampleKgExtraction(baseUrl) {
  const response = await fetch(`${baseUrl}/api/kg/chapters/${encodeURIComponent('c1')}/extraction`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      bookId: 'book-1',
      model: 'test-model',
      extraction: {
        entities: [
          { name: '林青', type: 'person', aliases: ['少年林青'], evidence: '林青第一次离开山村', confidence: 0.96 },
          { name: '白衣客', type: 'person', evidence: '遇见神秘的白衣客', confidence: 0.92 },
          { name: '阿梨', type: 'person', evidence: '阿梨在青州等候', confidence: 0.91 },
          { name: '青州', type: 'location', evidence: '前往青州', confidence: 0.88 },
        ],
        relations: [
          { source: '林青', target: '白衣客', type: 'meets', evidence: '林青遇见白衣客', confidence: 0.9 },
          { source: '阿梨', target: '青州', type: 'located_in', evidence: '阿梨在青州等候', confidence: 0.86 },
        ],
      },
    }),
  })
  assert.equal(response.status, 200)
}

async function saveSecondBookKgExtraction(baseUrl) {
  const response = await fetch(`${baseUrl}/api/kg/chapters/${encodeURIComponent('c3')}/extraction`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      bookId: 'book-2',
      model: 'test-model',
      extraction: {
        entities: [
          { name: '韩立', type: 'person', evidence: '韩立来到灵谷', confidence: 0.94 },
          { name: '灵谷', type: 'location', evidence: '灵谷深处', confidence: 0.88 },
        ],
        relations: [
          { source: '韩立', target: '灵谷', type: 'located_in', evidence: '韩立来到灵谷', confidence: 0.83 },
        ],
      },
    }),
  })
  assert.equal(response.status, 200)
}

async function saveSecondChapterMergeKgExtraction(baseUrl) {
  const response = await fetch(`${baseUrl}/api/kg/chapters/${encodeURIComponent('c2')}/extraction`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      bookId: 'book-1',
      model: 'test-model',
      extraction: {
        entities: [
          { name: '少年林青', type: 'person', aliases: ['青衣少年'], evidence: '青衣少年再次遇见白衣客', confidence: 0.89 },
          { name: '白衣客', type: 'person', evidence: '白衣客传授线索', confidence: 0.9 },
        ],
        relations: [
          { source: '少年林青', target: '白衣客', type: 'meets', evidence: '少年林青再次遇见白衣客', confidence: 0.84 },
        ],
      },
    }),
  })
  assert.equal(response.status, 200)
}

async function saveSplitKgExtractions(baseUrl) {
  const firstChapterResponse = await fetch(`${baseUrl}/api/kg/chapters/${encodeURIComponent('c1')}/extraction`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      bookId: 'book-1',
      model: 'test-model',
      extraction: {
        entities: [
          { name: '林青', type: 'person', aliases: ['青衣少年'], evidence: '林青第一次离开山村', confidence: 0.96 },
          { name: '白衣客', type: 'person', evidence: '遇见神秘的白衣客', confidence: 0.92 },
        ],
        relations: [
          { source: '林青', target: '白衣客', type: 'meets', evidence: '林青初遇白衣客', confidence: 0.9 },
        ],
      },
    }),
  })
  assert.equal(firstChapterResponse.status, 200)

  const secondChapterResponse = await fetch(`${baseUrl}/api/kg/chapters/${encodeURIComponent('c2')}/extraction`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      bookId: 'book-1',
      model: 'test-model',
      extraction: {
        entities: [
          { name: '林青', type: 'person', aliases: ['青衣少年'], evidence: '青衣少年换装入城', confidence: 0.89 },
          { name: '白衣客', type: 'person', evidence: '白衣客传授线索', confidence: 0.9 },
        ],
        relations: [
          { source: '林青', target: '白衣客', type: 'meets', evidence: '青衣少年再见白衣客', confidence: 0.84 },
        ],
      },
    }),
  })
  assert.equal(secondChapterResponse.status, 200)
}

async function saveReviewQueueKgExtraction(baseUrl) {
  const response = await fetch(`${baseUrl}/api/kg/chapters/${encodeURIComponent('c1')}/extraction`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      bookId: 'book-1',
      model: 'test-model',
      extraction: {
        entities: [
          { name: '林青', type: 'character', description: '山村少年。', evidence: '林青初遇白衣客', confidence: 0.96 },
          { name: '白衣客', type: 'character', description: '神秘来客。', evidence: '白衣客出现', confidence: 0.92 },
          { name: '阿梨', type: 'character', description: '青州旧友。', evidence: '阿梨在青州等候', confidence: 0.91 },
          { name: '青州', type: 'location', description: '故事中的城镇。', evidence: '前往青州', confidence: 0.88 },
          { name: '影', type: 'other', aliases: ['影#1'], evidence: '影子掠过', confidence: 0.3 },
        ],
        relations: [
          { source: '林青', target: '白衣客', type: 'related_to', evidence: '林青初遇白衣客', confidence: 0.4 },
          { source: '阿梨', target: '青州', type: 'located_in', evidence: '阿梨在青州等候', confidence: 0.35 },
          { source: '影', target: '林青', type: 'related_to', evidence: '影子跟随林青', confidence: 0.25 },
        ],
      },
    }),
  })
  assert.equal(response.status, 200)
}

async function saveCoreferenceKgExtractions(baseUrl) {
  const firstChapterResponse = await fetch(`${baseUrl}/api/kg/chapters/${encodeURIComponent('c1')}/extraction`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      bookId: 'book-1',
      model: 'test-model',
      extraction: {
        entities: [
          { name: '南宫婉', type: 'character', aliases: ['精灵少女'], description: '掩月宗修士。', evidence: '南宫婉出现在掩月宗', confidence: 0.94 },
          { name: '掩月宗', type: 'sect', description: '修仙宗门。', evidence: '掩月宗山门', confidence: 0.9 },
          { name: '韩立', type: 'character', description: '另一名修士。', evidence: '韩立旁观', confidence: 0.91 },
        ],
        relations: [
          { source: '南宫婉', target: '掩月宗', type: 'member_of', description: '南宫婉属于掩月宗。', evidence: '南宫婉出现在掩月宗', confidence: 0.89 },
          { source: '韩立', target: '掩月宗', type: 'member_of', description: '韩立暂住掩月宗。', evidence: '韩立旁观掩月宗事务', confidence: 0.82 },
        ],
      },
    }),
  })
  assert.equal(firstChapterResponse.status, 200)

  const secondChapterResponse = await fetch(`${baseUrl}/api/kg/chapters/${encodeURIComponent('c2')}/extraction`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      bookId: 'book-1',
      model: 'test-model',
      extraction: {
        entities: [
          { name: '精灵少女', type: 'character', aliases: ['南宫婉'], description: '南宫婉早期身份。', evidence: '精灵少女现身', confidence: 0.88 },
          { name: '掩月宗', type: 'sect', description: '修仙宗门。', evidence: '掩月宗弟子迎接', confidence: 0.86 },
        ],
        relations: [
          { source: '精灵少女', target: '掩月宗', type: 'member_of', description: '精灵少女也属于掩月宗。', evidence: '精灵少女被掩月宗弟子迎接', confidence: 0.84 },
        ],
      },
    }),
  })
  assert.equal(secondChapterResponse.status, 200)
}

async function startMockOpenAiChatServer({ clusters }) {
  const requests = []
  const server = createHttpServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const rawBody = Buffer.concat(chunks).toString('utf8')
    const body = rawBody ? JSON.parse(rawBody) : null
    requests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body,
    })

    if (request.method !== 'POST' || request.url !== '/chat/completions') {
      response.writeHead(404, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: 'not found' }))
      return
    }

    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({ clusters }),
          },
        },
      ],
    }))
  })

  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve)
    server.on('error', reject)
  })
  const address = server.address()

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

async function startMockEmbeddingServer() {
  const requests = []
  const server = createHttpServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const rawBody = Buffer.concat(chunks).toString('utf8')
    requests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: rawBody ? JSON.parse(rawBody) : null,
    })

    if (request.method !== 'POST' || request.url !== '/embeddings') {
      response.writeHead(404, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: 'not found' }))
      return
    }

    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }))
  })

  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve)
    server.on('error', reject)
  })
  const address = server.address()

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

async function waitForKgJob(baseUrl, bookId, jobId) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 10_000) {
    const payload = await fetchJson(`${baseUrl}/api/kg/scan/status?bookId=${encodeURIComponent(bookId)}`)
    if (payload.job?.id === jobId && payload.job.status !== 'running') return payload.job
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out waiting for KG job ${jobId}`)
}

async function saveDiffPreviewInitialExtraction(baseUrl) {
  const response = await fetch(`${baseUrl}/api/kg/chapters/${encodeURIComponent('c1')}/extraction`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      bookId: 'book-1',
      model: 'initial-model',
      extraction: {
        entities: [
          { name: '林青', type: 'character', description: '山村少年。', evidence: '林青初遇白衣客', confidence: 0.96 },
          { name: '白衣客', type: 'character', description: '神秘来客。', evidence: '白衣客出现', confidence: 0.92 },
          { name: '阿梨', type: 'character', description: '青州旧友。', evidence: '阿梨在青州等候', confidence: 0.91 },
          { name: '青州', type: 'location', description: '故事中的城镇。', evidence: '前往青州', confidence: 0.88 },
        ],
        relations: [
          { source: '林青', target: '白衣客', type: 'knows', description: '初次相识。', evidence: '林青初遇白衣客', confidence: 0.9 },
          { source: '阿梨', target: '青州', type: 'located_in', description: '阿梨位于青州。', evidence: '阿梨在青州等候', confidence: 0.86 },
        ],
      },
    }),
  })
  assert.equal(response.status, 200)
}

function diffPreviewReplacementExtraction() {
  return {
    entities: [
      { name: '林青', type: 'character', description: '山村少年。', evidence: '林青与白衣客同行', confidence: 0.97 },
      { name: '白衣客', type: 'character', description: '神秘来客。', evidence: '白衣客同行', confidence: 0.93 },
      { name: '夜枭', type: 'character', description: '暗中追踪林青的人。', evidence: '夜枭现身', confidence: 0.82 },
    ],
    relations: [
      { source: '林青', target: '白衣客', type: 'knows', description: '继续同行。', evidence: '林青与白衣客同行', confidence: 0.91 },
      { source: '夜枭', target: '林青', type: 'enemy_of', description: '夜枭追踪林青。', evidence: '夜枭追踪林青', confidence: 0.8 },
    ],
  }
}

function markReviewItems(baseUrl, kind, status, ids) {
  return fetch(`${baseUrl}/api/kg/review-queue/mark`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, kind, status }),
  })
}

function deleteReviewItems(baseUrl, kind, ids) {
  return fetch(`${baseUrl}/api/kg/review-queue/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, kind }),
  })
}

function updateRelation(baseUrl, relationId, payload) {
  return fetch(`${baseUrl}/api/kg/relations/${encodeURIComponent(relationId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

async function countOrphanGraphRows(tempDir) {
  const db = new DatabaseSync(join(tempDir, 'novel_reader.sqlite'), { readOnly: true })
  try {
    const entityMentionOrphans = db.prepare(`
      SELECT COUNT(*) AS count
      FROM kg_entity_mentions mention
      LEFT JOIN kg_entities entity ON entity.id = mention.entity_id
      WHERE entity.id IS NULL
    `).get().count
    const relationMentionOrphans = db.prepare(`
      SELECT COUNT(*) AS count
      FROM kg_relation_mentions mention
      LEFT JOIN kg_relations relation ON relation.id = mention.relation_id
      WHERE relation.id IS NULL
    `).get().count
    const endpointOrphans = db.prepare(`
      SELECT COUNT(*) AS count
      FROM kg_relations relation
      LEFT JOIN kg_entities source ON source.id = relation.source_entity_id
      LEFT JOIN kg_entities target ON target.id = relation.target_entity_id
      WHERE source.id IS NULL OR target.id IS NULL
    `).get().count
    return entityMentionOrphans + relationMentionOrphans + endpointOrphans
  } finally {
    db.close()
  }
}

async function fetchJson(url) {
  const response = await fetch(url)
  assert.equal(response.status, 200)
  return response.json()
}

function sampleState(options = {}) {
  const books = [
    {
      book: {
        id: 'book-1',
        title: '测试小说',
        importedAt: '2026-06-30T00:00:00.000Z',
        chapters: [
          { id: 'c1', index: 1, title: '第一章', content: '第一章正文', wordCount: 5 },
          { id: 'c2', index: 2, title: '第二章', content: '第二章正文', wordCount: 5 },
        ],
      },
      activeChapterId: 'c1',
      summaries: {
        c1: {
          short: '短概要',
          detail: '详细概要',
          keyPoints: ['要点'],
          skippable: '不可跳读',
          generatedBy: 'local',
        },
      },
    },
  ]

  if (options.includeSecondBook) {
    books.push({
      book: {
        id: 'book-2',
        title: '第二本测试小说',
        importedAt: '2026-06-30T00:10:00.000Z',
        chapters: [
          { id: 'c3', index: 1, title: '第一章 灵谷', content: '韩立来到灵谷', wordCount: 6 },
        ],
      },
      activeChapterId: 'c3',
      summaries: {},
    })
  }

  return {
    books,
    activeBookId: 'book-1',
    book: null,
    activeChapterId: 'c1',
    summaries: {},
  }
}

async function writeBufferFile(path, buffer) {
  await writeFile(path, buffer)
}
