<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { DocumentChecked, RefreshRight, ScaleToOriginal, View } from '@element-plus/icons-vue'
import { useRevisionStore } from '@/stores/revisionStore'
import { useHallStore } from '@/stores/hallStore'
import { useRepairStore } from '@/stores/repairStore'
import { REVISION_KIND_LABELS, type LayerRevision } from '@/types/layerRevision'
import SeverityTag from '@/components/common/SeverityTag.vue'

const props = defineProps<{ elementId: string }>()

const emit = defineEmits<{
  /** 继续处理待生效草稿 */
  resume: [revision: LayerRevision]
}>()

const revisionStore = useRevisionStore()
const hallStore = useHallStore()
const repairStore = useRepairStore()

const historyVisible = ref(false)
const detail = ref<LayerRevision | null>(null)

const draft = computed(() => revisionStore.draftOfElement(props.elementId))
const applied = computed(() => revisionStore.appliedOfElement(props.elementId))

const pendingCount = computed(() => draft.value?.decayAssignments.filter((item) => item.targetLayerId === null).length ?? 0)
const affectedCount = computed(() => draft.value?.decayAssignments.length ?? 0)

function resumeDraft(): void {
  if (draft.value) emit('resume', draft.value)
}

async function discardDraft(): Promise<void> {
  if (!draft.value) return
  const confirmed = await ElMessageBox.confirm(
    '放弃后该份待生效校订将被删除；层位、病害、工序均保持现状不变。是否继续？',
    '放弃校订草稿',
    { type: 'warning' }
  ).catch(() => false)
  if (!confirmed) return
  await revisionStore.discardDraft(draft.value.id)
  ElMessage.success('校订草稿已放弃')
}

function showDetail(revision: LayerRevision): void {
  detail.value = revision
  historyVisible.value = true
}

function layerLabel(layerId: string, revision: LayerRevision): string {
  const snapshot = revision.sourceSnapshots.find((item) => item.layerId === layerId)
  const current = hallStore.layers.find((layer) => layer.id === layerId)
  if (current) return `第 ${current.level} 层 · ${current.patternName} / ${current.pigment}`
  if (snapshot) return `原第 ${snapshot.level} 层 · ${snapshot.patternName} / ${snapshot.pigment}（已作废 / 改录）`
  return layerId
}

function resultLabel(revision: LayerRevision, resultId: string): string {
  const result = revision.resultLayers.find((item) => item.id === resultId)
  const current = hallStore.layers.find((layer) => layer.id === resultId)
  const levelText = current ? `现第 ${current.level} 层` : '层位已删'
  if (!result) return levelText
  return `${result.isOriginal ? '原遍' : '新遍'} · ${result.patternName} / ${result.pigment}（${levelText}）`
}

function formatTime(value: number | null): string {
  if (!value) return '—'
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

function stepsOfDecay(decayId: string) {
  return repairStore.steps.filter((step) => step.decayId === decayId).length
}
</script>

<template>
  <div>
    <div v-if="draft" class="revision-draft">
      <div class="revision-draft__head">
        <el-tag type="warning" effect="dark">待复核校订</el-tag>
        <strong>{{ REVISION_KIND_LABELS[draft.kind] }}</strong>
        <el-tag size="small" type="danger" effect="plain" v-if="pendingCount > 0">
          {{ pendingCount }} 条病害归属存疑
        </el-tag>
        <el-tag size="small" type="info" effect="plain">涉及病害 {{ affectedCount }} 条</el-tag>
      </div>
      <p class="revision-draft__reason">{{ draft.reason || '（尚未填写校订依据）' }}</p>
      <div class="revision-draft__actions">
        <el-button size="small" type="primary" :icon="RefreshRight" @click="resumeDraft">
          继续处理{{ pendingCount > 0 ? '并定遍' : ' / 生效' }}
        </el-button>
        <el-button size="small" text type="danger" @click="discardDraft">放弃草稿</el-button>
        <span class="muted revision-draft__hint">
          草稿未生效前，层位、病害与工序均保持原样；失败可重试，不会留下半套结果。
        </span>
      </div>
    </div>

    <div class="revision-history">
      <div class="revision-history__head">
        <span class="muted">
          <el-icon><DocumentChecked /></el-icon>
          已生效校订履历：{{ applied.length }} 条
        </span>
        <el-button v-if="applied.length > 0" size="small" text :icon="View" @click="historyVisible = true">
          查看校订关系
        </el-button>
      </div>
    </div>

    <el-drawer v-model="historyVisible" title="层位校订履历（含校订关系）" size="640px">
      <div v-if="detail" class="revision-detail">
        <el-descriptions :column="1" size="small" border>
          <el-descriptions-item label="校订类型">{{ REVISION_KIND_LABELS[detail.kind] }}</el-descriptions-item>
          <el-descriptions-item label="生效时间">{{ formatTime(detail.appliedAt) }}</el-descriptions-item>
          <el-descriptions-item label="校订依据">{{ detail.reason || '—' }}</el-descriptions-item>
          <el-descriptions-item label="原层位">
            <div v-for="snapshot in detail.sourceSnapshots" :key="snapshot.layerId" class="detail-line">
              原第 {{ snapshot.level }} 层 · {{ snapshot.patternName }} / {{ snapshot.pigment }} ·
              {{ snapshot.thicknessMm }}mm
            </div>
          </el-descriptions-item>
          <el-descriptions-item label="校订后遍">
            <div v-for="result in detail.resultLayers" :key="result.id" class="detail-line">
              <el-tag size="small" :type="result.isOriginal ? 'success' : 'warning'" effect="plain">
                {{ result.isOriginal ? '原遍' : '新遍' }}
              </el-tag>
              {{ result.patternName }} / {{ result.pigment }} · {{ result.thicknessMm }}mm ·
              {{ layerLabel(result.id, detail) }}
            </div>
          </el-descriptions-item>
        </el-descriptions>

        <h4>病害归属（修复工序随病害自动指向同一遍）</h4>
        <el-table :data="detail.decayAssignments" size="small" border max-height="300">
          <el-table-column label="病害" min-width="150">
            <template #default="{ row }">
              <SeverityTag :severity="row.severity" :area-cm2="row.areaCm2" size="small" plain />
              <span class="detail-decay-type">{{ row.decayType }}</span>
            </template>
          </el-table-column>
          <el-table-column label="原属" min-width="150">
            <template #default="{ row }">{{ layerLabel(row.fromLayerId, detail) }}</template>
          </el-table-column>
          <el-table-column label="校订后" min-width="170">
            <template #default="{ row }">
              <span v-if="row.targetLayerId">{{ resultLabel(detail, row.targetLayerId) }}</span>
              <el-tag v-else size="small" type="danger" effect="plain">生效时已归位</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="工序" width="70">
            <template #default="{ row }">{{ stepsOfDecay(row.decayId) }} 道</template>
          </el-table-column>
        </el-table>
        <p v-if="detail.decayAssignments.length === 0" class="muted">本次校订不涉及病害记录。</p>
      </div>

      <el-empty v-if="applied.length === 0" description="暂无已生效的校订" />
      <el-scrollbar v-else>
        <div
          v-for="revision in [...applied].reverse()"
          :key="revision.id"
          class="history-item"
          :class="{ 'is-active': detail && detail.id === revision.id }"
          @click="showDetail(revision)"
        >
          <el-icon><ScaleToOriginal /></el-icon>
          <div>
            <p>{{ REVISION_KIND_LABELS[revision.kind] }} · {{ formatTime(revision.appliedAt) }}</p>
            <span class="muted">{{ revision.reason || '无校订依据记录' }}</span>
          </div>
        </div>
      </el-scrollbar>
    </el-drawer>
  </div>
</template>

<style scoped>
.revision-draft {
  padding: 12px 14px;
  margin-bottom: 10px;
  background: #fdf6ec;
  border: 1px solid #f0d9ac;
  border-radius: 10px;
}

.revision-draft__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.revision-draft__reason {
  margin: 8px 0;
  font-size: 13px;
  color: #6b6257;
}

.revision-draft__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.revision-draft__hint {
  font-size: 12px;
}

.revision-history {
  margin-top: 10px;
}

.revision-history__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 13px;
}

.revision-detail h4 {
  margin: 16px 0 8px;
  font-size: 14px;
}

.detail-line {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}

.detail-decay-type {
  margin-left: 6px;
}

.history-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  margin-bottom: 8px;
  background: #fbf9f5;
  border: 1px solid var(--line);
  border-radius: 8px;
  cursor: pointer;
}

.history-item.is-active {
  border-color: #8a5a2b;
  background: #faf3e8;
}

.history-item p {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}

.history-item span {
  font-size: 12px;
}
</style>
