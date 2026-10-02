import { defineStore } from 'pinia'
import { computed } from 'vue'
import { useIdbTable } from '@/hooks/useIdbTable'
import type { LayerRevision } from '@/types/layerRevision'
import {
  applyRevision as serviceApply,
  buildMergeDraft,
  buildSplitDraft,
  findOpenDraft,
  removeRevision as serviceRemove,
  saveDraft as serviceSaveDraft,
  validateRevision,
  type RevisionDraftInput,
  type RevisionValidation
} from '@/services/layerRevisionService'
import type { PaintLayer } from '@/types/layer'

/**
 * 层位校订 store：订阅 layerRevisions 表，封装拆分 / 合并草稿与一次性生效。
 * 真正的写库与事务逻辑在 layerRevisionService，这里只做响应式与页面交互适配。
 */
export const useRevisionStore = defineStore('layerRevision', () => {
  const revisionsTable = useIdbTable<LayerRevision>((database) => database.layerRevisions, {
    sortByUpdatedAt: false
  })

  const revisions = computed<LayerRevision[]>(() =>
    [...revisionsTable.rows.value].sort((a, b) => a.createdAt - b.createdAt)
  )

  function revisionsOfElement(elementId: string): LayerRevision[] {
    return revisions.value.filter((item) => item.elementId === elementId)
  }

  function draftOfElement(elementId: string): LayerRevision | undefined {
    return revisions.value.find((item) => item.elementId === elementId && item.status === 'draft')
  }

  function appliedOfElement(elementId: string): LayerRevision[] {
    return revisionsOfElement(elementId).filter((item) => item.status === 'applied')
  }

  async function createSplitDraft(source: PaintLayer, input: RevisionDraftInput): Promise<LayerRevision> {
    const draft = await buildSplitDraft(source, input)
    await serviceSaveDraft(draft)
    return draft
  }

  async function createMergeDraft(
    outer: PaintLayer,
    inner: PaintLayer,
    input: RevisionDraftInput
  ): Promise<LayerRevision> {
    const draft = await buildMergeDraft(outer, inner, input)
    await serviceSaveDraft(draft)
    return draft
  }

  async function saveDraft(revision: LayerRevision): Promise<void> {
    await serviceSaveDraft(revision)
  }

  async function discardDraft(id: string): Promise<void> {
    await serviceRemove(id)
  }

  async function checkRevision(revision: LayerRevision): Promise<RevisionValidation> {
    return validateRevision(revision)
  }

  /** 一次性生效：失败抛错，事务保证无半成品，调用方可直接重试同一份草稿 */
  async function apply(revision: LayerRevision): Promise<LayerRevision> {
    return serviceApply(revision)
  }

  async function openDraftOf(elementId: string): Promise<LayerRevision | undefined> {
    return findOpenDraft(elementId)
  }

  return {
    revisions,
    ready: computed(() => revisionsTable.ready),
    revisionsOfElement,
    draftOfElement,
    appliedOfElement,
    createSplitDraft,
    createMergeDraft,
    saveDraft,
    discardDraft,
    checkRevision,
    apply,
    openDraftOf
  }
})
