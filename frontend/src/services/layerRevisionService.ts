import { db, createId } from '@/utils/db'
import type { PaintLayer, PatternName, Pigment } from '@/types/layer'
import type { Decay } from '@/types/decay'
import type {
  LayerRevision,
  RevisionDecayAssignment,
  RevisionKind,
  RevisionLayerSnapshot,
  RevisionResultLayer,
  SplitNewSide
} from '@/types/layerRevision'

/** 新建草稿时的表单输入 */
export interface RevisionDraftInput {
  elementId: string
  kind: RevisionKind
  reason: string
  splitNewSide?: SplitNewSide
}

function snapshotOf(layer: PaintLayer): RevisionLayerSnapshot {
  return {
    layerId: layer.id,
    level: layer.level,
    patternName: layer.patternName,
    pigment: layer.pigment,
    thicknessMm: layer.thicknessMm
  }
}

function assignmentOf(
  decay: Decay,
  targetLayerId: string,
  note = ''
): RevisionDecayAssignment {
  return {
    decayId: decay.id,
    fromLayerId: decay.layerId,
    targetLayerId,
    decayType: decay.type,
    severity: decay.severity,
    areaCm2: decay.areaCm2,
    note
  }
}

/**
 * 组装拆分草稿：原遍沿用源层主键（病害默认留在原遍），新遍预分配新主键。
 * 新遍默认拷贝原遍档案值，由用户在对话框里改定。
 */
export async function buildSplitDraft(
  source: PaintLayer,
  input: RevisionDraftInput
): Promise<LayerRevision> {
  const now = Date.now()
  const newLayerId = createId('lay')
  const side: SplitNewSide = input.splitNewSide ?? 'inner'
  const decays = await db.decays.where('layerId').equals(source.id).toArray()
  // 由外至内排列结果层
  const originalResult: RevisionResultLayer = {
    id: source.id,
    level: side === 'outer' ? source.level + 1 : source.level,
    patternName: source.patternName,
    pigment: source.pigment,
    thicknessMm: source.thicknessMm,
    isOriginal: true,
    note: '旧档原录遍（沿用原层主键，病害默认挂此遍）'
  }
  const newResult: RevisionResultLayer = {
    id: newLayerId,
    level: side === 'outer' ? source.level : source.level + 1,
    patternName: source.patternName,
    pigment: source.pigment,
    thicknessMm: source.thicknessMm,
    isOriginal: false,
    note: '新认出的叠压遍（复核补录）'
  }
  return {
    id: createId('rev'),
    elementId: input.elementId,
    kind: 'split',
    status: 'draft',
    reason: input.reason,
    sourceLayerId: source.id,
    sourceLayerIds: [source.id],
    sourceSnapshots: [snapshotOf(source)],
    splitNewSide: side,
    resultLayers: side === 'outer' ? [newResult, originalResult] : [originalResult, newResult],
    // 归属说不清的病害可在对话框改派新遍或移入待复核区；默认全部留在原遍
    decayAssignments: decays.map((decay) => assignmentOf(decay, source.id)),
    appliedAt: null,
    createdAt: now,
    updatedAt: now
  }
}

/**
 * 组装合并草稿：默认保留两层中由外至内更靠外的一层，
 * 两层上的病害（及其修复工序，工序只认 decayId）统一改挂保留层。
 */
export async function buildMergeDraft(
  outer: PaintLayer,
  inner: PaintLayer,
  input: RevisionDraftInput
): Promise<LayerRevision> {
  const now = Date.now()
  const [first, second] = outer.level <= inner.level ? [outer, inner] : [inner, outer]
  const decays = await db.decays.where('layerId').anyOf([first.id, second.id]).toArray()
  const keptResult: RevisionResultLayer = {
    id: first.id,
    level: first.level,
    patternName: first.patternName,
    pigment: first.pigment,
    thicknessMm: first.thicknessMm,
    isOriginal: true,
    note: `合并保留层（原第 ${first.level} 层，另一层作废）`
  }
  return {
    id: createId('rev'),
    elementId: input.elementId,
    kind: 'merge',
    status: 'draft',
    reason: input.reason,
    sourceLayerId: null,
    sourceLayerIds: [first.id, second.id],
    sourceSnapshots: [snapshotOf(first), snapshotOf(second)],
    splitNewSide: null,
    resultLayers: [keptResult],
    decayAssignments: decays
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((decay) => assignmentOf(decay, first.id)),
    appliedAt: null,
    createdAt: now,
    updatedAt: now
  }
}

export interface RevisionValidation {
  errors: string[]
  /** 待复核（归属存疑）的病害数；大于 0 时禁止生效 */
  pendingCount: number
}

/** 生效前校验：除结构完整性外，所有写入条件都在事务内按库内最新状态再校一次 */
export async function validateRevision(revision: LayerRevision): Promise<RevisionValidation> {
  const errors: string[] = []
  let pendingCount = 0

  if (revision.kind === 'split') {
    if (revision.sourceLayerIds.length !== 1) errors.push('拆分校订必须且只能有一个源层位')
    if (revision.resultLayers.length !== 2) errors.push('拆分校订必须有两个结果层位')
    const sourceId = revision.sourceLayerIds[0]
    if (sourceId) {
      const source = await db.layers.get(sourceId)
      if (!source) errors.push('源层位已不存在，校订无法生效，可放弃后重新发起')
      if (source && source.elementId !== revision.elementId) errors.push('源层位不属于该构件')
    }
    const original = revision.resultLayers.find((item) => item.isOriginal)
    const created = revision.resultLayers.find((item) => !item.isOriginal)
    if (!original || !created) {
      errors.push('结果层位必须包含一条原遍与一条新遍')
    } else {
      if (original.id !== revision.sourceLayerIds[0]) errors.push('原遍必须沿用源层位主键')
      if (await db.layers.get(created.id)) {
        errors.push('新遍层位主键与现有层位冲突，刷新后重试')
      }
    }
  } else {
    if (revision.sourceLayerIds.length !== 2) errors.push('合并校订必须有两个源层位')
    const [a, b] = revision.sourceLayerIds
    if (a === b) errors.push('合并的两个层位不能相同')
    if (revision.resultLayers.length !== 1) errors.push('合并校订只能保留一个结果层位')
    const layers = await db.layers.where('id').anyOf(revision.sourceLayerIds).toArray()
    if (layers.length !== revision.sourceLayerIds.length) {
      errors.push('存在已被删除的源层位，校订无法生效，可放弃后重新发起')
    }
    if (layers.some((layer) => layer.elementId !== revision.elementId)) errors.push('源层位不属于该构件')
    const keepId = revision.resultLayers[0]?.id
    if (keepId && !revision.sourceLayerIds.includes(keepId)) {
      errors.push('合并保留层必须是两个源层位之一')
    }
  }

  const resultIds = new Set(revision.resultLayers.map((item) => item.id))
  revision.decayAssignments.forEach((assignment) => {
    if (assignment.targetLayerId === null) {
      pendingCount += 1
    } else if (!resultIds.has(assignment.targetLayerId)) {
      errors.push(`病害 ${assignment.decayId} 的归属层位不在校订结果中`)
    }
  })
  if (pendingCount > 0) errors.push(`仍有 ${pendingCount} 条病害归属存疑（待复核区），需逐条定遍后方可生效`)

  // 同一构件存在其它待生效草稿时禁止生效，避免层位重排互相覆盖
  const otherDrafts = await db.layerRevisions
    .where('elementId')
    .equals(revision.elementId)
    .toArray()
  if (otherDrafts.some((item) => item.status === 'draft' && item.id !== revision.id)) {
    errors.push('该构件还有其它待生效的层位校订，请先生效或放弃后再处理')
  }
  return { errors, pendingCount }
}

/** 保存（或更新）草稿：单条 put 本身原子，失败不会产生半成品 */
export async function saveDraft(revision: LayerRevision): Promise<void> {
  await db.layerRevisions.put({ ...revision, status: 'draft', appliedAt: null, updatedAt: Date.now() })
}

export async function removeRevision(id: string): Promise<void> {
  await db.layerRevisions.delete(id)
}

async function renumberByOrder(_elementId: string, orderedIds: string[], now: number): Promise<void> {
  for (let index = 0; index < orderedIds.length; index += 1) {
    const level = index + 1
    const layer = await db.layers.get(orderedIds[index])
    if (layer && layer.level !== level) {
      await db.layers.update(layer.id, { level, updatedAt: now })
    }
  }
}

/**
 * 一次性生效校订：
 * 拆分 = 原遍就地更新 + 新遍插入 + 病害按归属改派 + 全构件层位重排；
 * 合并 = 保留层更新 + 另一层删除 + 病害改挂保留层 + 重排。
 * 全部写操作与校订记录置为 applied 处在同一个 Dexie 事务中，
 * 任一步失败整体回滚，绝不留下半套结果；调用方可在失败后原样重试。
 */
export async function applyRevision(revision: LayerRevision): Promise<LayerRevision> {
  const validation = await validateRevision(revision)
  if (validation.errors.length > 0) {
    throw new Error(validation.errors.join('；'))
  }
  const now = Date.now()
  const assignmentByDecay = new Map(revision.decayAssignments.map((item) => [item.decayId, item]))

  await db.transaction(
    'rw',
    [db.layers, db.decays, db.elements, db.layerRevisions],
    async () => {
      const siblings = (
        await db.layers.where('elementId').equals(revision.elementId).toArray()
      ).sort((a, b) => a.level - b.level)

      if (revision.kind === 'split') {
        const original = revision.resultLayers.find((item) => item.isOriginal)
        const created = revision.resultLayers.find((item) => !item.isOriginal)
        if (!original || !created) throw new Error('拆分结果层位不完整')
        const source = siblings.find((layer) => layer.id === original.id)
        if (!source) throw new Error('源层位已不存在')

        // 原遍就地更新（沿用主键，病害 / 工序引用不断）
        await db.layers.put({
          ...source,
          patternName: original.patternName,
          pigment: original.pigment,
          thicknessMm: original.thicknessMm,
          updatedAt: now
        })
        await db.layers.put({
          id: created.id,
          elementId: revision.elementId,
          // 事务内先给占位序号，随后统一按物理顺序重排，避免唯一序号冲突
          level: created.level,
          patternName: created.patternName,
          pigment: created.pigment,
          thicknessMm: created.thicknessMm,
          createdAt: now,
          updatedAt: now
        })

        // 病害按草稿归属改派；草稿之后新增的病害默认仍在原遍，不做搬移
        const affectedDecays = await db.decays.where('layerId').anyOf(revision.sourceLayerIds).toArray()
        for (const decay of affectedDecays) {
          const target = assignmentByDecay.get(decay.id)?.targetLayerId
          if (target && target !== decay.layerId) {
            await db.decays.update(decay.id, { layerId: target, updatedAt: now })
          }
        }

        const orderedIds: string[] = []
        siblings.forEach((layer) => {
          if (layer.id === source.id && revision.splitNewSide === 'outer') {
            orderedIds.push(created.id, source.id)
          } else if (layer.id === source.id) {
            orderedIds.push(source.id, created.id)
          } else {
            orderedIds.push(layer.id)
          }
        })
        await renumberByOrder(revision.elementId, orderedIds, now)
      } else {
        const kept = revision.resultLayers[0]
        const removedId = revision.sourceLayerIds.find((id) => id !== kept.id)
        if (!removedId) throw new Error('合并源层位不完整')
        const keptLayer = siblings.find((layer) => layer.id === kept.id)
        if (!keptLayer) throw new Error('保留层位已不存在')

        await db.layers.put({
          ...keptLayer,
          patternName: kept.patternName,
          pigment: kept.pigment,
          thicknessMm: kept.thicknessMm,
          updatedAt: now
        })

        // 病害逐条改挂保留层（修复工序只认 decayId，自动跟随，无需改动）
        const affectedDecays = await db.decays.where('layerId').anyOf(revision.sourceLayerIds).toArray()
        for (const decay of affectedDecays) {
          const target = assignmentByDecay.get(decay.id)?.targetLayerId ?? kept.id
          if (target !== decay.layerId) {
            await db.decays.update(decay.id, { layerId: target, updatedAt: now })
          }
        }
        await db.layers.delete(removedId)

        // 重排：合并后只少一层，保留层移动到两层中更靠外（索引更小）的那个位置；
        // 未参与层相对顺序不变，统一按由外至内重编号。
        const removedIndex = siblings.findIndex((layer) => layer.id === removedId)
        const keptIndex = siblings.findIndex((layer) => layer.id === kept.id)
        const orderedIds = siblings
          .filter((layer) => layer.id !== removedId && layer.id !== kept.id)
          .map((layer) => layer.id)
        orderedIds.splice(Math.min(removedIndex, keptIndex), 0, kept.id)
        await renumberByOrder(revision.elementId, orderedIds, now)
      }

      const finalLayers = await db.layers.where('elementId').equals(revision.elementId).toArray()
      const element = await db.elements.get(revision.elementId)
      if (element && element.layerCount !== finalLayers.length) {
        await db.elements.update(revision.elementId, { layerCount: finalLayers.length, updatedAt: now })
      }
      await db.layerRevisions.put({ ...revision, status: 'applied' as const, appliedAt: now, updatedAt: now })
    }
  )

  return { ...revision, status: 'applied', appliedAt: now, updatedAt: now }
}

/** 该构件是否存在待生效草稿（同一构件同一时刻只允许一份，保证重排不冲突） */
export async function findOpenDraft(elementId: string): Promise<LayerRevision | undefined> {
  const list = await db.layerRevisions.where('elementId').equals(elementId).toArray()
  return list.find((item) => item.status === 'draft')
}

/** 结果层的默认颜料 / 做法候选项，供对话框编辑 */
export function cloneResultEditable(result: RevisionResultLayer): {
  patternName: PatternName
  pigment: Pigment
  thicknessMm: number
} {
  return {
    patternName: result.patternName,
    pigment: result.pigment,
    thicknessMm: result.thicknessMm
  }
}
