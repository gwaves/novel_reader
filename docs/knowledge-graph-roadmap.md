# Novel Knowledge Graph Roadmap

## Goal

Build a local-first knowledge graph for each imported novel. The graph should extract and connect characters, items, skills, sects, locations, beasts, and other story entities from every chapter. It should preserve chapter-level extraction results, support resumable scans, and provide query and visualization pages for global and entity-focused relationship graphs.

## Current Status

As of 2026-06-20, the original Phase 1-5 roadmap is largely implemented:

- Foundation, extraction persistence, resumable scanning, and chapter-level replay are complete.
- Entity/relation browsing, editing, merging, splitting, endpoint correction, and review queue workflows are complete.
- Entity neighborhood graphs and filtered global graph views are complete.
- Evidence search, JSON/GraphML export, and RAG search over summary embeddings are complete.
- Global LLM-assisted coreference cleanup is available for likely duplicate character identities.

The next development focus should shift from adding more graph operations to making destructive or model-assisted operations measurable and reversible:

1. Add a repeatable quality-evaluation suite for extraction, coreference, graph maintenance, and RAG search.
2. Add audit logs and rollback support for high-impact operations such as coreference merges, batch deletes, and override rescans.
3. Upgrade search with FTS5 and richer filters once quality and recovery workflows are in place.

## Storage Choice

Use the existing local SQLite database at:

```text
~/.novel_reader/novel_reader.sqlite
```

SQLite is the first implementation target because it is lightweight, local, easy to back up, and already part of the app. Instead of introducing a heavy graph database service, model the graph with entity and relation tables:

```text
kg_scan_jobs
kg_chapter_extractions
kg_entities
kg_entity_mentions
kg_relations
kg_relation_mentions
```

This gives us a property-graph model while keeping deployment simple. If graph querying later needs more power, this schema can be exported to KuzuDB, Neo4j, GraphML, or JSON.

## Entity Types

Initial supported entity types:

```text
character   Person or sentient role
sect        Sect, clan, school, organization
item        Item, treasure, artifact, weapon, pill
skill       Skill, cultivation method, spell, divine ability
location    Place, realm, cave, city, region
beast       Pet, spirit beast, monster, demon beast
event       Important event, optional in early UI
other       Fallback when type is uncertain
```

## Relation Types

Initial supported relation types:

```text
knows
ally_of
enemy_of
master_of
disciple_of
member_of
belongs_to
owns
uses
learns
created_by
located_in
appears_with
transforms_into
related_to
```

The first version should tolerate imperfect relation types. Unknown or uncertain relations can fall back to `related_to`.

## Chapter Scan Flow

Each chapter scan should be resumable and auditable:

```text
chapter text
  -> LLM extraction
  -> save chapter-level raw JSON
  -> normalize entity names and aliases
  -> upsert kg_entities
  -> insert kg_entity_mentions
  -> upsert kg_relations
  -> insert kg_relation_mentions
```

The raw extraction JSON is important. It lets us improve merging, relation typing, or prompts later without losing chapter-level evidence.

## Intermediate Extraction Shape

Each chapter extraction should be normalized toward this shape:

```json
{
  "chapterId": "...",
  "entities": [
    {
      "name": "韩立",
      "type": "character",
      "aliases": ["韩兄"],
      "description": "本章中出现的身份或行为摘要",
      "confidence": 0.95,
      "evidence": ["原文短句"]
    }
  ],
  "relations": [
    {
      "source": "韩立",
      "target": "七玄门",
      "type": "member_of",
      "description": "韩立与七玄门的关系",
      "confidence": 0.9,
      "evidence": ["原文短句"]
    }
  ]
}
```

## UI Roadmap

### Phase 1: Foundation

- Add knowledge graph SQLite tables.
- Add API endpoints for scan status, chapter extraction persistence, entity queries, and relation queries.
- Add a basic "Knowledge Graph" entry point in the app.
- Support single-chapter scan first.
- Store chapter-level extraction JSON even if graph merging is still basic.

### Phase 2: Entity Query

- Add entity list page.
- Filter entities by type.
- Search entities by name and alias.
- Add entity detail page with:
  - aliases
  - description
  - first/last seen chapter
  - mention timeline
  - related entities
  - evidence snippets

### Phase 3: Graph Visualization

- Add a one-hop relation graph for a selected entity.
- Add graph filters by entity type and relation type.
- Add dedicated global graph views:
  - character graph
  - skill graph
  - sect/organization graph
  - item graph
  - beast/pet graph

Use React Flow for interactive graph visualization. Avoid rendering a huge full graph at once; default to filtered views and depth-limited entity neighborhoods.

### Phase 4: Disambiguation and Maintenance

- Add merge entity flow.
- Add split entity flow.
- Edit aliases, entity type, descriptions, and relation types.
- Mark low-confidence entities and relations for review.
- Allow chapter rescans and graph rebuilds from raw extraction JSON.

### Phase 5: Search and Export

- Add full-text search over mentions and evidence.
- Add vector search for semantic lookup.
- Export graph as JSON and GraphML.
- Evaluate KuzuDB if graph traversal needs outgrow SQLite tables.

## Implementation Order

1. Document roadmap and data model.
2. Add SQLite schema and API endpoints.
3. Add basic Knowledge Graph page and scan controls.
4. Implement single-chapter extraction using the configured model.
5. Implement batch scan with resumable jobs.
6. Add entity list and entity detail pages.
7. Add relationship graph visualization.
8. Add entity merge/edit tooling.

## First MVP Scope

The first MVP should avoid overbuilding. It should support:

- scan current chapter
- save chapter extraction JSON
- upsert basic entities and relations
- list entities for current book
- open one entity detail with mentions and relations

Once this works reliably, batch scanning the whole book and graph visualization can build on top of it.
