import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { locateSummaryKeyPointSources } from '../../scripts/summary-source-locator.mjs'

describe('summary source locator', () => {
  it('falls back to a real sentence window for an abstracted Chinese key point', () => {
    const content = '西门庆走进厅来，与众人寒暄。潘金莲闻知消息，暗中安排春梅送信给孟玉楼。吴月娘随后设宴款待众人。'
    const keyPoint = '潘金莲借春梅秘密联络孟玉楼，推动后续安排。'
    const [source] = locateSummaryKeyPointSources(content, [keyPoint], [])

    assert.ok(source)
    assert.equal(source.locator, 'fuzzy-character-overlap')
    assert.equal(source.quote, content.slice(source.startOffset, source.endOffset))
    assert.match(source.quote, /潘金莲.*春梅.*孟玉楼/)
  })

  it('does not manufacture a location without meaningful overlap', () => {
    const content = '众人在花园饮酒赏月。'
    const [source] = locateSummaryKeyPointSources(content, ['朝廷派兵攻打边关'], [])
    assert.equal(source, undefined)
  })
})
