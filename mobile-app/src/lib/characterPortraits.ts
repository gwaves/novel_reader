import type {
  MobileBookPackage,
  MobileCharacterPortrait,
  MobileKgEntity,
  MobileKgEntityMention,
  MobileKgRelation,
} from './mobileApi'

export type CharacterPortraitCard = {
  entity: MobileKgEntity
  portraitUrl: string | null
  portraitTone: string
  portraitSource: string | null
  mentionCount: number
  relationCount: number
  firstEvidence: MobileKgEntityMention | null
  relatedNames: string[]
  rankScore: number
}

const BUILT_IN_PORTRAITS: MobileCharacterPortrait[] = [
  {
    names: ['耿照', '小耿', '典卫大人', '阿照'],
    source: 'demo',
    tone: 'ember',
    url: '/portraits/yaodao/geng-zhao.png',
  },
  {
    names: ['明栈雪', '明姑娘', '白衣女郎'],
    source: 'demo',
    tone: 'jade',
    url: '/portraits/yaodao/ming-zhanxue.png',
  },
  {
    names: ['横疏影', '横二总管', '暗香浮动'],
    source: 'demo',
    tone: 'teal',
    url: '/portraits/yaodao/heng-shuying.png',
  },
  {
    names: ['染红霞', '红霞', '染二掌院', '万里枫江'],
    source: 'demo',
    tone: 'crimson',
    url: '/portraits/yaodao/ran-hongxia.png',
  },
  {
    names: ['黄缨', '黄樱', '阿缨', '黄衣少女'],
    source: 'demo',
    tone: 'ochre',
    url: '/portraits/yaodao/huang-ying.png',
  },
]

const FALLBACK_TONES = ['jade', 'teal', 'crimson', 'ochre', 'ember'] as const

function normalizeName(value: string): string {
  return value.trim().toLowerCase()
}

function getPortraitIdentityNames(entity: MobileKgEntity): string[] {
  return [entity.name, entity.normalizedName].filter(Boolean)
}

function hashString(value: string): number {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0
  }
  return hash
}

function isSupportedTone(value: string | null | undefined): value is string {
  return Boolean(value && FALLBACK_TONES.includes(value as (typeof FALLBACK_TONES)[number]))
}

function getPackagePortraits(pkg: MobileBookPackage): MobileCharacterPortrait[] {
  return Array.isArray(pkg.portraits?.characters) ? pkg.portraits.characters : []
}

function getPortraitMatch(entity: MobileKgEntity, portraits: MobileCharacterPortrait[]): MobileCharacterPortrait | null {
  const byEntityId = portraits.find((portrait) => portrait.entityId && portrait.entityId === entity.id)
  if (byEntityId) return byEntityId

  const names = new Set(getPortraitIdentityNames(entity).map(normalizeName))
  return (
    portraits.find((portrait) => {
      const canonicalName = portrait.names[0]
      return Boolean(canonicalName && names.has(normalizeName(canonicalName)))
    }) ?? null
  )
}

function getRelationCount(entity: MobileKgEntity, relations: MobileKgRelation[]): number {
  return relations.filter((relation) => relation.sourceEntityId === entity.id || relation.targetEntityId === entity.id).length
}

function getRelatedNames(
  entity: MobileKgEntity,
  entitiesById: Map<string, MobileKgEntity>,
  relations: MobileKgRelation[],
): string[] {
  const names = new Set<string>()
  for (const relation of relations) {
    if (relation.sourceEntityId === entity.id) {
      const target = entitiesById.get(relation.targetEntityId)
      if (target) names.add(target.name)
    } else if (relation.targetEntityId === entity.id) {
      const source = entitiesById.get(relation.sourceEntityId)
      if (source) names.add(source.name)
    }
    if (names.size >= 4) break
  }
  return Array.from(names)
}

export function buildCharacterPortraitCards(pkg: MobileBookPackage): CharacterPortraitCard[] {
  const mentionsByEntity = new Map<string, MobileKgEntityMention[]>()
  for (const mention of pkg.knowledgeGraph.entityMentions) {
    const current = mentionsByEntity.get(mention.entityId) ?? []
    current.push(mention)
    mentionsByEntity.set(mention.entityId, current)
  }

  const entitiesById = new Map(pkg.knowledgeGraph.entities.map((entity) => [entity.id, entity]))
  const portraitCandidates = [...getPackagePortraits(pkg), ...BUILT_IN_PORTRAITS]

  return pkg.knowledgeGraph.entities
    .filter((entity) => entity.type === 'character')
    .map((entity) => {
      const mentions = (mentionsByEntity.get(entity.id) ?? []).sort((a, b) => a.chapterIndex - b.chapterIndex)
      const portrait = getPortraitMatch(entity, portraitCandidates)
      const relationCount = getRelationCount(entity, pkg.knowledgeGraph.relations)
      const hasPortraitBoost = portrait ? 100000 : 0
      const mentionCount = mentions.length
      const fallbackTone = FALLBACK_TONES[hashString(entity.id || entity.name) % FALLBACK_TONES.length]
      return {
        entity,
        portraitTone: isSupportedTone(portrait?.tone) ? portrait.tone : fallbackTone,
        portraitSource: portrait?.source ?? null,
        portraitUrl: portrait?.url ?? null,
        mentionCount,
        relationCount,
        firstEvidence: mentions.find((mention) => mention.evidence) ?? mentions[0] ?? null,
        relatedNames: getRelatedNames(entity, entitiesById, pkg.knowledgeGraph.relations),
        rankScore: hasPortraitBoost + mentionCount * 10 + relationCount,
      }
    })
    .sort((a, b) => {
      if (b.rankScore !== a.rankScore) return b.rankScore - a.rankScore
      return (a.entity.firstChapterIndex ?? 999999) - (b.entity.firstChapterIndex ?? 999999)
    })
}

export function getCharacterInitial(name: string): string {
  const trimmed = name.trim()
  return trimmed.slice(Math.max(0, trimmed.length - 2)) || '人物'
}
