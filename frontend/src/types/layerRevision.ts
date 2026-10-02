import type { DecayType, Severity } from '@/types/decay'
import type { PatternName, Pigment } from '@/types/layer'

/**
 * 层位校订：复核旧档时，一处彩画可能被误记为一层（实际两遍叠压，需「拆分」），
 * 也可能两处相邻层位本是同一遍（需「合并」）。
 *
 * 关键约定：病害记录与修复工序始终指向「原来的那遍画」（层主键），
 * 而不是按层号搬移。拆分时原遍沿用原层主键，新遍分配新主键；
 * 合并时保留一层沿用其主键，另一层作废，病害逐条改挂保留层。
 */
export type RevisionKind = 'split' | 'merge'
export type RevisionStatus = 'draft' | 'applied'
/** 拆分时，新认出的那遍位于原遍的外侧（由外至内序号更小）还是内侧 */
export type SplitNewSide = 'outer' | 'inner'

/** 校订前源层的档案快照，保证校订生效、原层被改写后仍可查 */
export interface RevisionLayerSnapshot {
  layerId: string
  level: number
  patternName: PatternName
  pigment: Pigment
  thicknessMm: number
}

/** 校订后的结果层（由外至内顺序） */
export interface RevisionResultLayer {
  /**
   * 拆分：原遍沿用源层主键（isOriginal=true），新遍为预分配的新主键；
   * 合并：仅一条，沿用被保留层的主键。
   */
  id: string
  /** 建草稿时拟定的由外至内序号，生效时以实际层位统一重排为准 */
  level: number
  patternName: PatternName
  pigment: Pigment
  thicknessMm: number
  /** 是否为旧档中原录的那遍画（沿用原层主键，病害默认留在此遍） */
  isOriginal: boolean
  note: string
}

/** 单条病害在校订前后的归属映射 */
export interface RevisionDecayAssignment {
  decayId: string
  /** 校订前该病害所在层主键 */
  fromLayerId: string
  /** 校订后归属的结果层主键；null 表示归属存疑、放入待复核区（此时校订不可生效） */
  targetLayerId: string | null
  /** 病害快照字段，原病害日后被删时校订记录仍可查 */
  decayType: DecayType
  severity: Severity
  areaCm2: number
  note: string
}

export interface LayerRevision {
  id: string
  elementId: string
  kind: RevisionKind
  /** draft=待生效草稿（可反复修改、重试）；applied=已一次性生效 */
  status: RevisionStatus
  /** 校订依据 / 复核说明 */
  reason: string
  /** 拆分源层主键；合并时为 null，使用 sourceLayerIds */
  sourceLayerId: string | null
  /** 参与校订的源层主键（拆分 1 个、合并 2 个） */
  sourceLayerIds: string[]
  sourceSnapshots: RevisionLayerSnapshot[]
  /** 拆分时新遍相对原遍的位置；合并时为 null */
  splitNewSide: SplitNewSide | null
  /** 拆分 2 条（由外至内）；合并 1 条 */
  resultLayers: RevisionResultLayer[]
  /** 受影响病害的逐条归属；targetLayerId 为 null 的即待复核项 */
  decayAssignments: RevisionDecayAssignment[]
  appliedAt: number | null
  createdAt: number
  updatedAt: number
}

export const REVISION_KIND_LABELS: Record<RevisionKind, string> = {
  split: '拆分（一层实为两遍叠压）',
  merge: '合并（两层本是同一遍）'
}
