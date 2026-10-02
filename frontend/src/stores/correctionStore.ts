import { defineStore } from 'pinia'
import { computed } from 'vue'
import { db } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import { unresolvedCount, type CorrectionAssignment, type LayerCorrection } from '@/types/correction'
import type { PaintLayer } from '@/types/layer'

/** 暂存一条校订的入参：原层快照与目标方案由页面按当前层位组装 */
export interface StageCorrectionPayload {
  elementId: string
  kind: LayerCorrection['kind']
  sources: LayerCorrection['sources']
  targets: LayerCorrection['targets']
  assignments: CorrectionAssignment[]
  note: string
}

/**
 * 层位校订 store：校订先暂存进待复核区，归属处理完后一次生效。
 * 生效动作放在单个 Dexie 事务里，失败整体回滚并标记 failed，可重试，不留半套结果。
 */
export const useCorrectionStore = defineStore('correction', () => {
  const correctionsTable = useIdbTable<LayerCorrection>((database) => database.corrections)

  const corrections = computed<LayerCorrection[]>(() => correctionsTable.rows.value)

  function correctionsOfElement(elementId: string): LayerCorrection[] {
    return corrections.value.filter((correction) => correction.elementId === elementId)
  }

  /** 待复核区：未生效（待复核 / 生效失败）的校订 */
  function openCorrectionsOfElement(elementId: string): LayerCorrection[] {
    return correctionsOfElement(elementId).filter((correction) => correction.status !== 'applied')
  }

  /** 已生效的校订记录（校订历史，保留原层快照可查） */
  function appliedCorrectionsOfElement(elementId: string): LayerCorrection[] {
    return correctionsOfElement(elementId).filter((correction) => correction.status === 'applied')
  }

  /** 某层位是否被未生效的校订引用：是则不允许直接删除该层位 */
  function hasOpenCorrectionForLayer(layerId: string): boolean {
    return corrections.value.some(
      (correction) =>
        correction.status !== 'applied' && correction.sources.some((source) => source.layerId === layerId)
    )
  }

  /** 暂存校订：只写校订单，不动原层位、病害与工序 */
  async function stageCorrection(payload: StageCorrectionPayload): Promise<LayerCorrection> {
    return correctionsTable.create(
      {
        elementId: payload.elementId,
        kind: payload.kind,
        status: 'pending',
        sources: payload.sources,
        targets: payload.targets,
        assignments: payload.assignments,
        note: payload.note,
        failReason: null,
        appliedAt: null
      },
      'cor'
    )
  }

  /** 更新暂存中的归属判定与备注（待复核区里「继续处理」） */
  async function updateCorrection(
    id: string,
    patch: Partial<Pick<LayerCorrection, 'targets' | 'assignments' | 'note'>>
  ): Promise<void> {
    await correctionsTable.update(id, patch)
  }

  /** 撤销未生效的校订：仅删除校订单，原层位与病害保持原样 */
  async function cancelCorrection(id: string): Promise<void> {
    const correction = corrections.value.find((item) => item.id === id)
    if (!correction || correction.status === 'applied') return
    await correctionsTable.remove(id)
  }

  /**
   * 一次生效：在单个事务内完成 新层落库 → 病害按归属改指 → 原层删除 →
   * 层序重排 → 构件层数回写 → 校订标记已生效。
   * 任一步失败整个事务回滚，随后把校订标记为 failed 供重试。
   */
  async function applyCorrection(id: string): Promise<void> {
    const correction = await db.corrections.get(id)
    if (!correction) throw new Error('校订记录不存在，可能已被撤销')
    if (correction.status === 'applied') return
    const pending = unresolvedCount(correction)
    if (pending > 0) {
      throw new Error(`还有 ${pending} 条病害归属待复核，处理完后才能一次生效`)
    }
    try {
      await db.transaction('rw', [db.layers, db.decays, db.elements, db.corrections], async () => {
        const now = Date.now()
        const sourceIds = correction.sources.map((source) => source.layerId)

        // 1. 原层位必须仍然完整存在（暂存后被删则无法生效）
        const currentSources = await db.layers.where('id').anyOf(sourceIds).toArray()
        if (currentSources.length !== sourceIds.length) {
          throw new Error('原层位已不存在，校订无法生效，请撤销后重新校订')
        }

        // 2. 原层位上的病害必须全部已有归属（防止暂存后新增病害漏判）
        const sourceDecays = await db.decays.where('layerId').anyOf(sourceIds).toArray()
        const assignedIds = new Set(correction.assignments.map((assignment) => assignment.decayId))
        const missing = sourceDecays.filter((decay) => !assignedIds.has(decay.id))
        if (missing.length > 0) {
          throw new Error(`原层位有 ${missing.length} 条新增病害尚未判定归属，请先在待复核区处理`)
        }

        // 3. 组装生效后的层位序列：在原层位置插入目标遍，其余保持由外至内顺序
        const elementLayers = (await db.layers.where('elementId').equals(correction.elementId).toArray()).sort(
          (a, b) => a.level - b.level
        )
        const sourceIdSet = new Set(sourceIds)
        // 合并时以当前更靠外的那处原层位置落新层
        const anchorSourceId = currentSources.sort((a, b) => a.level - b.level)[0]?.id ?? sourceIds[0]
        const targetLayers: PaintLayer[] = correction.targets.map((target) => ({
          id: target.layerId,
          elementId: correction.elementId,
          level: 0,
          patternName: target.patternName,
          pigment: target.pigment,
          thicknessMm: target.thicknessMm,
          createdAt: now,
          updatedAt: now
        }))
        const ordered: PaintLayer[] = []
        elementLayers.forEach((layer) => {
          if (!sourceIdSet.has(layer.id)) {
            ordered.push(layer)
            return
          }
          if (layer.id === anchorSourceId) ordered.push(...targetLayers)
        })

        // 4. 层序重排为 1..n 并落库，随后删除原层
        const puts = ordered.map((layer, index) => ({ ...layer, level: index + 1, updatedAt: now }))
        await db.layers.bulkPut(puts)
        await db.layers.bulkDelete(sourceIds)

        // 5. 病害按归属逐条改指目标遍；修复工序经 decayId 自动跟随，无需改动
        for (const assignment of correction.assignments) {
          const target = assignment.targetIndex === null ? undefined : correction.targets[assignment.targetIndex]
          if (!target) throw new Error('校订归属数据不完整，请撤销后重新校订')
          await db.decays.update(assignment.decayId, { layerId: target.layerId, updatedAt: now })
        }

        // 6. 回写构件层数，保持卡片回显一致
        await db.elements.update(correction.elementId, { layerCount: puts.length, updatedAt: now })

        // 7. 校订标记已生效（同事务，任一步失败都不会留下半套结果）
        await db.corrections.update(id, { status: 'applied', appliedAt: now, failReason: null, updatedAt: now })
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : '校订生效失败，请重试'
      await db.corrections.update(id, { status: 'failed', failReason: message, updatedAt: Date.now() })
      throw new Error(message)
    }
  }

  return {
    corrections,
    correctionsOfElement,
    openCorrectionsOfElement,
    appliedCorrectionsOfElement,
    hasOpenCorrectionForLayer,
    stageCorrection,
    updateCorrection,
    cancelCorrection,
    applyCorrection
  }
})
