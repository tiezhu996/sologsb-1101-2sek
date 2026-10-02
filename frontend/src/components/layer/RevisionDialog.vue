<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { CircleCheckFilled, RefreshLeft, WarningFilled } from '@element-plus/icons-vue'
import SeverityTag from '@/components/common/SeverityTag.vue'
import { useHallStore } from '@/stores/hallStore'
import { useDecayStore } from '@/stores/decayStore'
import { useRepairStore } from '@/stores/repairStore'
import { useRevisionStore } from '@/stores/revisionStore'
import { PATTERN_NAMES, PIGMENTS, type PaintLayer, type PatternName, type Pigment } from '@/types/layer'
import type { Decay } from '@/types/decay'
import type { LayerRevision, RevisionDecayAssignment, SplitNewSide } from '@/types/layerRevision'
import { buildMergeDraft, buildSplitDraft, type RevisionDraftInput } from '@/services/layerRevisionService'

type DialogMode = 'split' | 'merge'

const props = defineProps<{
  modelValue: boolean
  mode: DialogMode
  elementId: string
  /** 拆分传 1 个源层 id；合并传 2 个源层 id */
  sourceIds: string[]
  /** 继续编辑既有草稿时传草稿 id */
  revisionId?: string | null
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  /** 校订已一次性生效 */
  applied: []
}>()

const hallStore = useHallStore()
const decayStore = useDecayStore()
const repairStore = useRepairStore()
const revisionStore = useRevisionStore()

const visible = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value)
})

const draft = ref<LayerRevision | null>(null)
const reason = ref('')
const splitNewSide = ref<SplitNewSide>('inner')
const mergeKeepId = ref('')
const saving = ref(false)
const applying = ref(false)
const loadingDraft = ref(false)
const staleDecayIds = ref<Set<string>>(new Set())
const newDecayCount = ref(0)

const patternOptions = PATTERN_NAMES
const pigmentOptions = PIGMENTS

const elementLayers = computed<PaintLayer[]>(() => hallStore.layersOfElement(props.elementId))
const sourceLayers = computed<PaintLayer[]>(() =>
  props.sourceIds
    .map((id) => elementLayers.value.find((layer) => layer.id === id))
    .filter((layer): layer is PaintLayer => Boolean(layer))
    .sort((a, b) => a.level - b.level)
)

const isPersisted = computed(() => Boolean(props.revisionId))
const pendingAssignments = computed<RevisionDecayAssignment[]>(
  () => draft.value?.decayAssignments.filter((item) => item.targetLayerId === null) ?? []
)
const settledAssignments = computed<RevisionDecayAssignment[]>(
  () => draft.value?.decayAssignments.filter((item) => item.targetLayerId !== null) ?? []
)

/** 归属调整前列的「原属」：优先用源层快照，兼容新拆草稿之外的引用 */
function fromLayerLabel(layerId: string): string {
  const snapshot = draft.value?.sourceSnapshots.find((item) => item.layerId === layerId)
  if (snapshot) return `原第 ${snapshot.level} 层`
  const result = draft.value?.resultLayers.find((item) => item.id === layerId)
  if (result) return result.isOriginal ? `原遍（原第 ${result.level} 层）` : '新认出遍'
  return '源层'
}

function decayOf(assignment: RevisionDecayAssignment): Decay | null {
  return decayStore.decays.find((decay) => decay.id === assignment.decayId) ?? null
}

function stepsOfDecay(decayId: string) {
  const list = repairStore.steps
    .filter((step) => step.decayId === decayId)
    .sort((a, b) => a.seq - b.seq)
  const done = list.filter((step) => step.state === '已完成').length
  return { list, done }
}

/** 草稿可能保存了一段时间：同步库内最新病害（新增的补入、已删的标记留档） */
function syncAssignmentsWithDb(next: LayerRevision): void {
  const stale = new Set<string>()
  const existing = new Map(next.decayAssignments.map((item) => [item.decayId, item]))
  const liveIds = new Set(decayStore.decays.map((decay) => decay.id))
  next.decayAssignments.forEach((item) => {
    if (!liveIds.has(item.decayId)) stale.add(item.decayId)
  })
  const sourceSet = new Set(next.sourceLayerIds)
  const defaultTarget =
    next.kind === 'split'
      ? (next.resultLayers.find((item) => item.isOriginal)?.id ?? next.sourceLayerIds[0])
      : next.resultLayers[0].id
  let added = 0
  decayStore.decays
    .filter((decay) => sourceSet.has(decay.layerId))
    .forEach((decay) => {
      if (!existing.has(decay.id)) {
        next.decayAssignments.push({
          decayId: decay.id,
          fromLayerId: decay.layerId,
          targetLayerId: defaultTarget,
          decayType: decay.type,
          severity: decay.severity,
          areaCm2: decay.areaCm2,
          note: ''
        })
        added += 1
      } else {
        // 快照字段随库内最新值刷新，归属（targetLayerId）以草稿为准不动
        const item = existing.get(decay.id)!
        item.decayType = decay.type
        item.severity = decay.severity
        item.areaCm2 = decay.areaCm2
      }
    })
  staleDecayIds.value = stale
  newDecayCount.value = added
}

async function loadDraft(): Promise<void> {
  loadingDraft.value = true
  staleDecayIds.value = new Set()
  newDecayCount.value = 0
  try {
    if (props.revisionId) {
      const found = revisionStore.revisions.find((item) => item.id === props.revisionId)
      if (!found) {
        ElMessage.error('校订草稿不存在，可能已被放弃')
        visible.value = false
        return
      }
      draft.value = structuredClone(found)
    } else if (props.mode === 'split') {
      const source = sourceLayers.value[0]
      if (!source) {
        ElMessage.error('未找到要拆分的源层位')
        visible.value = false
        return
      }
      const input: RevisionDraftInput = { elementId: props.elementId, kind: 'split', reason: '' }
      draft.value = await buildSplitDraft(source, input)
    } else {
      const [outer, inner] = sourceLayers.value
      if (!outer || !inner) {
        ElMessage.error('请选择两个相邻层位进行合并')
        visible.value = false
        return
      }
      const input: RevisionDraftInput = { elementId: props.elementId, kind: 'merge', reason: '' }
      draft.value = await buildMergeDraft(outer, inner, input)
    }
    reason.value = draft.value.reason
    splitNewSide.value = draft.value.splitNewSide ?? 'inner'
    mergeKeepId.value = draft.value.resultLayers[0]?.id ?? ''
    syncAssignmentsWithDb(draft.value)
  } finally {
    loadingDraft.value = false
  }
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) void loadDraft()
  }
)

function updateResultEditable(
  resultId: string,
  patch: Partial<Pick<LayerRevision['resultLayers'][number], 'patternName' | 'pigment' | 'thicknessMm'>>
): void {
  if (!draft.value) return
  const result = draft.value.resultLayers.find((item) => item.id === resultId)
  if (result) Object.assign(result, patch)
}

function setAssignmentTarget(assignment: RevisionDecayAssignment, targetId: string | null): void {
  assignment.targetLayerId = targetId === '' ? null : targetId
}

function movePendingToDefault(): void {
  if (!draft.value) return
  const defaultTarget =
    draft.value.kind === 'split'
      ? draft.value.resultLayers.find((item) => item.isOriginal)?.id ?? null
      : draft.value.resultLayers[0].id
  pendingAssignments.value.forEach((item) => {
    item.targetLayerId = defaultTarget
  })
}

/** 拆分时切换新遍在外 / 在内：结果层换序、序号对调，已定归属不变 */
function changeSplitSide(side: SplitNewSide): void {
  if (!draft.value) return
  splitNewSide.value = side
  draft.value.splitNewSide = side
  const levels = draft.value.resultLayers.map((item) => item.level).sort((a, b) => a - b)
  const original = draft.value.resultLayers.find((item) => item.isOriginal)
  const created = draft.value.resultLayers.find((item) => !item.isOriginal)
  if (!original || !created || levels.length < 2) return
  if (side === 'outer') {
    created.level = levels[0]
    original.level = levels[1]
    draft.value.resultLayers = [created, original]
  } else {
    original.level = levels[0]
    created.level = levels[1]
    draft.value.resultLayers = [original, created]
  }
}

/** 合并时换保留层：归属全部改指新保留层，可编辑档案取该层源值 */
function changeMergeKeep(keepId: string): void {
  if (!draft.value) return
  mergeKeepId.value = keepId
  const snapshot = draft.value.sourceSnapshots.find((item) => item.layerId === keepId)
  if (!snapshot) return
  draft.value.resultLayers = [
    {
      id: keepId,
      level: snapshot.level,
      patternName: snapshot.patternName,
      pigment: snapshot.pigment,
      thicknessMm: snapshot.thicknessMm,
      isOriginal: true,
      note: '合并保留层'
    }
  ]
  draft.value.decayAssignments.forEach((item) => {
    item.targetLayerId = keepId
  })
}

function buildPersistPayload(): LayerRevision | null {
  if (!draft.value) return null
  return {
    ...draft.value,
    reason: reason.value.trim(),
    updatedAt: Date.now()
  }
}

async function saveDraftOnly(): Promise<void> {
  const payload = buildPersistPayload()
  if (!payload) return
  if (!payload.reason) {
    ElMessage.warning('请先填写校订依据 / 复核说明')
    return
  }
  saving.value = true
  try {
    await revisionStore.saveDraft(payload)
    draft.value = structuredClone(payload)
    ElMessage.success('校订草稿已保存，可稍后在待复核区继续处理')
    visible.value = false
  } catch (err) {
    // 草稿保存失败：库内无任何改动，可直接重试
    ElMessage.error(err instanceof Error ? `保存失败：${err.message}，可重试` : '保存失败，可重试')
  } finally {
    saving.value = false
  }
}

async function confirmApply(): Promise<void> {
  const payload = buildPersistPayload()
  if (!payload) return
  if (!payload.reason) {
    ElMessage.warning('请先填写校订依据 / 复核说明')
    return
  }
  saving.value = true
  try {
    const check = await revisionStore.checkRevision(payload)
    if (check.errors.length > 0) {
      ElMessageBox.alert(check.errors.map((error) => `· ${error}`).join('<br/>'), '暂不能生效', {
        type: 'warning',
        dangerouslyUseHTMLString: true
      }).catch(() => undefined)
      return
    }
    const summary =
      payload.kind === 'split'
        ? `拆分后该构件层位将由 ${sourceLayers.value.length} 处相关层位变为 2 遍，病害按表内归属分别挂接。`
        : `合并后仅保留 1 遍，两处层位上的病害与工序统一指向保留遍。`
    const confirmed = await ElMessageBox.confirm(
      `${summary}校订将在单个事务内一次性生效，失败会整体回滚。是否确认？`,
      '层位校订生效确认',
      { type: 'warning', confirmButtonText: '确认生效', cancelButtonText: '再看看' }
    ).catch(() => false)
    if (!confirmed) return

    applying.value = true
    await revisionStore.apply(payload)
    ElMessage.success('层位校订已一次性生效，病害记录与修复工序均按原遍归属更新')
    emit('applied')
    visible.value = false
  } catch (err) {
    // 事务已整体回滚，不存在半套结果；保留整份草稿供原样重试
    ElMessage.error(
      (err instanceof Error ? err.message : '校订生效失败，数据未改动') + '，可修正后重试'
    )
  } finally {
    saving.value = false
    applying.value = false
  }
}

async function discardDraft(): Promise<void> {
  if (!draft.value) return
  if (isPersisted.value) {
    const confirmed = await ElMessageBox.confirm(
      '放弃后该份待生效校订将被删除（既有的层位、病害、工序均不受影响），是否继续？',
      '放弃校订草稿',
      { type: 'warning' }
    ).catch(() => false)
    if (!confirmed) return
    await revisionStore.discardDraft(draft.value.id)
    ElMessage.success('校订草稿已放弃')
  }
  visible.value = false
}
</script>

<template>
  <el-dialog
    v-model="visible"
    :title="mode === 'split' ? '层位校订 · 拆分（一层实为两遍叠压）' : '层位校订 · 合并（两层本是同一遍）'"
    width="900px"
    :close-on-click-modal="false"
  >
    <div v-loading="loadingDraft">
      <template v-if="draft">
        <el-alert type="info" :closable="false" show-icon class="revision-tip">
          <template #title>
            病害记录与修复工序始终指向「原来的那遍画」（层主键），不按层号搬移。
            归属说不清的病害请放入待复核区，待复核清空后才可一次性生效。
          </template>
        </el-alert>

        <div class="revision-section">
          <h4>校订前原档（原层快照，生效后仍可查）</h4>
          <el-table :data="sourceLayers" size="small" border>
            <el-table-column label="原层号" width="80">
              <template #default="{ row }">{{ row.level }}</template>
            </el-table-column>
            <el-table-column label="彩画做法" prop="patternName" width="100" />
            <el-table-column label="主色颜料" prop="pigment" width="100" />
            <el-table-column label="厚度" width="100">
              <template #default="{ row }">{{ row.thicknessMm }} mm</template>
            </el-table-column>
            <el-table-column label="该层病害 / 工序">
              <template #default="{ row }">
                <span class="mono">
                  病害 {{ hallStore.decaysOfLayer(row.id).length }} 条 · 工序
                  {{ repairStore.steps.filter((step) => hallStore.decaysOfLayer(row.id).some((d) => d.id === step.decayId)).length }} 道
                </span>
              </template>
            </el-table-column>
          </el-table>
        </div>

        <div class="revision-section">
          <h4>校订依据</h4>
          <el-input
            v-model="reason"
            type="textarea"
            :rows="2"
            maxlength="160"
            show-word-limit
            placeholder="如：剔铲见两层颜料叠压边界，外层石青旋子下还有一遍朱砂，旧档并录为一层"
          />
        </div>

        <div class="revision-section">
          <h4>校订后的遍</h4>
          <div v-if="mode === 'split'" class="revision-side">
            <span class="muted">新认出的一遍位于原遍：</span>
            <el-radio-group :model-value="splitNewSide" size="small" @change="changeSplitSide">
              <el-radio-button value="outer">外侧（更早一遍）</el-radio-button>
              <el-radio-button value="inner">内侧（更晚一遍）</el-radio-button>
            </el-radio-group>
          </div>
          <div v-else class="revision-side">
            <span class="muted">合并后保留：</span>
            <el-radio-group :model-value="mergeKeepId" size="small" @change="changeMergeKeep">
              <el-radio-button v-for="layer in sourceLayers" :key="layer.id" :value="layer.id">
                原第 {{ layer.level }} 层（{{ layer.patternName }} / {{ layer.pigment }}）
              </el-radio-button>
            </el-radio-group>
          </div>

          <el-table :data="draft.resultLayers" size="small" border class="revision-result-table">
            <el-table-column label="由外至内" width="90">
              <template #default="{ row }">
                <el-tag v-if="row.isOriginal" size="small" type="success" effect="plain">原遍</el-tag>
                <el-tag v-else size="small" type="warning" effect="plain">新遍</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="彩画做法" width="150">
              <template #default="{ row }">
                <el-select
                  :model-value="row.patternName"
                  size="small"
                  @update:model-value="(value: PatternName) => updateResultEditable(row.id, { patternName: value })"
                >
                  <el-option v-for="item in patternOptions" :key="item" :label="item" :value="item" />
                </el-select>
              </template>
            </el-table-column>
            <el-table-column label="主色颜料" width="140">
              <template #default="{ row }">
                <el-select
                  :model-value="row.pigment"
                  size="small"
                  @update:model-value="(value: Pigment) => updateResultEditable(row.id, { pigment: value })"
                >
                  <el-option v-for="item in pigmentOptions" :key="item" :label="item" :value="item" />
                </el-select>
              </template>
            </el-table-column>
            <el-table-column label="厚度（mm）" width="140">
              <template #default="{ row }">
                <el-input-number
                  :model-value="row.thicknessMm"
                  size="small"
                  :min="0.1"
                  :max="20"
                  :step="0.1"
                  :precision="1"
                  @update:model-value="(value?: number) => value && updateResultEditable(row.id, { thicknessMm: value })"
                />
              </template>
            </el-table-column>
            <el-table-column label="说明" prop="note" min-width="180" />
          </el-table>
        </div>

        <div v-if="newDecayCount > 0" class="revision-section">
          <el-alert
            :title="`检测到草稿保存后该层位新增了 ${newDecayCount} 条病害，已按默认归属（原遍 / 保留遍）补入，可逐条调整。`"
            type="success"
            :closable="false"
            show-icon
          />
        </div>

        <div class="revision-section">
          <div class="revision-section__head">
            <h4>待复核区（归属存疑，{{ pendingAssignments.length }} 条）</h4>
            <el-button
              v-if="pendingAssignments.length > 0"
              size="small"
              text
              type="primary"
              @click="movePendingToDefault"
            >
              全部定到{{ mode === 'split' ? '原遍' : '保留遍' }}
            </el-button>
          </div>
          <el-table v-if="pendingAssignments.length > 0" :data="pendingAssignments" size="small" border>
            <el-table-column label="病害" min-width="150">
              <template #default="{ row }">
                <span>{{ row.decayType }} · {{ row.areaCm2 }}cm²</span>
                <el-tag v-if="staleDecayIds.has(row.decayId)" size="small" type="info" effect="plain" class="stale-tag">
                  原病害已删，快照留存
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="原属层位" width="120">
              <template #default="{ row }">{{ fromLayerLabel(row.fromLayerId) }}</template>
            </el-table-column>
            <el-table-column label="定遍" width="220">
              <template #default="{ row }">
                <el-select
                  :model-value="row.targetLayerId ?? ''"
                  size="small"
                  placeholder="选择归属遍"
                  @update:model-value="(value: string) => setAssignmentTarget(row, value)"
                >
                  <el-option label="暂存疑，继续待复核" value="" />
                  <el-option
                    v-for="result in draft.resultLayers"
                    :key="result.id"
                    :label="result.isOriginal ? '原遍' : '新认出遍'"
                    :value="result.id"
                  />
                </el-select>
              </template>
            </el-table-column>
          </el-table>
          <p v-else class="muted revision-empty">暂无存疑病害。</p>
        </div>

        <div class="revision-section">
          <h4>病害逐条定遍与原工序（{{ settledAssignments.length }} 条已定）</h4>
          <el-table :data="settledAssignments" size="small" border max-height="320">
            <el-table-column label="病害" min-width="170">
              <template #default="{ row }">
                <div class="assignment-cell">
                  <SeverityTag :severity="row.severity" :area-cm2="row.areaCm2" size="small" plain />
                  <span>{{ row.decayType }}</span>
                  <el-tag v-if="staleDecayIds.has(row.decayId)" size="small" type="info" effect="plain">
                    原病害已删
                  </el-tag>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="原属" width="90">
              <template #default="{ row }">
                <el-tag size="small" effect="plain">{{ fromLayerLabel(row.fromLayerId) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="校订后归属" width="160">
              <template #default="{ row }">
                <el-select
                  :model-value="row.targetLayerId ?? ''"
                  size="small"
                  @update:model-value="(value: string) => setAssignmentTarget(row, value === '' ? null : value)"
                >
                  <el-option label="移入待复核区" value="" />
                  <el-option
                    v-for="result in draft.resultLayers"
                    :key="result.id"
                    :label="result.isOriginal ? '原遍' : '新认出遍'"
                    :value="result.id"
                  />
                </el-select>
              </template>
            </el-table-column>
            <el-table-column label="原修复工序" min-width="200">
              <template #default="{ row }">
                <template v-if="decayOf(row)">
                  <el-tooltip
                    v-if="stepsOfDecay(row.decayId).list.length > 0"
                    placement="top"
                    effect="light"
                  >
                    <template #content>
                      <div class="steps-tip">
                        <div v-for="step in stepsOfDecay(row.decayId).list" :key="step.id">
                          {{ step.seq }}. {{ step.name }}（{{ step.state }}）{{ step.operator ? ` · ${step.operator}` : '' }}
                        </div>
                      </div>
                    </template>
                    <el-tag size="small" type="success" effect="plain">
                      {{ stepsOfDecay(row.decayId).list.length }} 道 · 完成 {{ stepsOfDecay(row.decayId).done }}
                    </el-tag>
                  </el-tooltip>
                  <span v-else class="muted">尚未安排工序</span>
                </template>
                <el-tag v-else size="small" type="info" effect="plain">病害记录已删除，工序链见履历</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="复核备注" min-width="150">
              <template #default="{ row }">
                <el-input
                  v-model="row.note"
                  size="small"
                  placeholder="如：外层边缘起甲，应属新遍"
                  maxlength="60"
                />
              </template>
            </el-table-column>
          </el-table>
        </div>
      </template>
    </div>

    <template #footer>
      <div class="revision-footer">
        <el-button :icon="RefreshLeft" @click="discardDraft" :disabled="applying">
          {{ isPersisted ? '放弃草稿' : '取消' }}
        </el-button>
        <div>
          <el-button :loading="saving" :disabled="applying" @click="saveDraftOnly">存为待复核草稿</el-button>
          <el-button
            type="primary"
            :icon="CircleCheckFilled"
            :loading="applying"
            @click="confirmApply"
          >
            校验并一次性生效
          </el-button>
        </div>
      </div>
      <p v-if="applying" class="muted revision-retry-hint">
        <el-icon><WarningFilled /></el-icon>
        正在单个事务内生效；若失败会整体回滚，不会留下半套结果，可直接重新点击。
      </p>
    </template>
  </el-dialog>
</template>

<style scoped>
.revision-tip {
  margin-bottom: 14px;
}

.revision-section {
  margin-bottom: 16px;
}

.revision-section h4 {
  margin: 0 0 8px;
  font-size: 14px;
}

.revision-section__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.revision-side {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}

.revision-result-table {
  margin-top: 8px;
}

.assignment-cell {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.stale-tag {
  margin-left: 4px;
}

.revision-empty {
  margin: 4px 0 0;
  font-size: 13px;
}

.steps-tip {
  max-width: 280px;
  font-size: 12px;
  line-height: 1.8;
}

.revision-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.revision-retry-hint {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  margin: 8px 0 0;
  font-size: 12px;
}
</style>
