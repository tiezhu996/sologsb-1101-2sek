/** 层位校订：复核旧档时对彩画层位的拆分 / 合并判定 */
import type { PatternName, Pigment } from './layer'

/** 校订方式：拆分（一处实为两遍叠压）/ 合并（相邻两处本是一遍） */
export type CorrectionKind = 'split' | 'merge'
/** 校订状态：待复核（归属未处理完或未生效）/ 已生效 / 生效失败（可重试） */
export type CorrectionStatus = 'pending' | 'applied' | 'failed'

/** 原层位快照：生效后原层删除，仍可在校订记录中查到原来的那遍画 */
export interface CorrectionSource {
  layerId: string
  level: number
  patternName: PatternName
  pigment: Pigment
  thicknessMm: number
}

/** 校订产生的新一遍（目标层位方案）：id 在暂存时预生成，生效时原样落库 */
export interface CorrectionTarget {
  layerId: string
  patternName: PatternName
  pigment: Pigment
  thicknessMm: number
}

/** 单条病害的归属判定：targetIndex 为 targets 下标，null 表示归属说不清、先放待复核区 */
export interface CorrectionAssignment {
  decayId: string
  targetIndex: number | null
}

export interface LayerCorrection {
  id: string
  elementId: string
  kind: CorrectionKind
  status: CorrectionStatus
  /** 原层位快照：拆分 1 条 / 合并 2 条（按由外至内排序） */
  sources: CorrectionSource[]
  /** 新层位方案：拆分 2 条 / 合并 1 条 */
  targets: CorrectionTarget[]
  /** 原层位上每条病害的归属判定 */
  assignments: CorrectionAssignment[]
  /** 校订依据备注 */
  note: string
  /** 最近一次生效失败的原因，供重试前排查 */
  failReason: string | null
  appliedAt: number | null
  createdAt: number
  updatedAt: number
}

export const CORRECTION_KINDS: CorrectionKind[] = ['split', 'merge']

export const CORRECTION_KIND_LABELS: Record<CorrectionKind, string> = {
  split: '拆分',
  merge: '合并'
}

export const CORRECTION_STATUS_LABELS: Record<CorrectionStatus, string> = {
  pending: '待复核',
  applied: '已生效',
  failed: '生效失败'
}

/** 尚未判定归属（待复核）的病害条数 */
export function unresolvedCount(correction: LayerCorrection): number {
  return correction.assignments.filter((assignment) => assignment.targetIndex === null).length
}

/** 目标遍的展示名：第①遍 / 第②遍（由外至内） */
export function targetLabel(index: number): string {
  const marks = ['①', '②', '③', '④']
  return `第${marks[index] ?? String(index + 1)}遍`
}
