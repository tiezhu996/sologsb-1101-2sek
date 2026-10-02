import {
  db,
  DB_VERSION,
  createId,
  clearAllTables,
  stampBackupTime,
  type BackupPayload
} from '@/utils/db'

/** 校验备份对象的必备字段，返回错误信息数组（为空表示通过） */
export function validateBackup(input: unknown): { ok: boolean; errors: string[]; payload: BackupPayload | null } {
  const errors: string[] = []
  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: ['文件内容不是合法的 JSON 对象'], payload: null }
  }
  const obj = input as Partial<BackupPayload>
  if (obj.app !== 'gbmuralarch') errors.push('app 字段应为 gbmuralarch，文件来源不明')
  const collections: Array<keyof Pick<BackupPayload, 'halls' | 'elements' | 'layers' | 'decays' | 'repairSteps'>> = [
    'halls',
    'elements',
    'layers',
    'decays',
    'repairSteps'
  ]
  for (const key of collections) {
    if (!Array.isArray(obj[key])) errors.push(`${key} 字段缺失或不是数组`)
  }
  // corrections 为 v3 新增：旧版本备份允许缺省，按空数组兼容升级
  if (obj.corrections !== undefined && !Array.isArray(obj.corrections)) errors.push('corrections 字段不是数组')
  if (errors.length > 0) return { ok: false, errors, payload: null }
  const payload: BackupPayload = {
    app: 'gbmuralarch',
    dbVersion: typeof obj.dbVersion === 'number' ? obj.dbVersion : DB_VERSION,
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : new Date().toISOString(),
    halls: obj.halls ?? [],
    elements: obj.elements ?? [],
    layers: obj.layers ?? [],
    decays: obj.decays ?? [],
    repairSteps: obj.repairSteps ?? [],
    corrections: obj.corrections ?? []
  }
  return { ok: true, errors, payload }
}

/** 组装当前本地数据的备份对象（含层位校订关系） */
export async function buildBackupPayload(): Promise<BackupPayload> {
  const [halls, elements, layers, decays, repairSteps, corrections] = await Promise.all([
    db.halls.toArray(),
    db.elements.toArray(),
    db.layers.toArray(),
    db.decays.toArray(),
    db.repairSteps.toArray(),
    db.corrections.toArray()
  ])
  return {
    app: 'gbmuralarch',
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    halls,
    elements,
    layers,
    decays,
    repairSteps,
    corrections
  }
}

/** 导出 JSON 文件到浏览器下载目录 */
export async function exportBackupJson(): Promise<{ fileName: string; counts: Record<string, number> }> {
  const payload = await buildBackupPayload()
  const fileName = `gbmuralarch-backup-v${payload.dbVersion}-${payload.exportedAt.slice(0, 19).replace(/[:T]/g, '')}.json`
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
  stampBackupTime(payload.exportedAt)
  return {
    fileName,
    counts: {
      halls: payload.halls.length,
      elements: payload.elements.length,
      layers: payload.layers.length,
      decays: payload.decays.length,
      repairSteps: payload.repairSteps.length,
      corrections: payload.corrections.length
    }
  }
}

/** 读取用户选择的备份文件文本 */
export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.readAsText(file, 'utf-8')
  })
}

/**
 * 兼容升级：把旧版本备份规范化到当前结构。
 * 与 Dexie 的 .upgrade() 迁移同口径 —— 旧备份导入后无需再依赖库级迁移。
 */
export function upgradePayload(payload: BackupPayload): BackupPayload {
  const decays = payload.decays.map((decay) => ({
    ...decay,
    repaired: typeof decay.repaired === 'boolean' ? decay.repaired : false,
    repairedAt:
      decay.repaired && !decay.repairedAt ? (decay.updatedAt ?? Date.now()) : (decay.repairedAt ?? null)
  }))
  const corrections = (payload.corrections ?? []).map((correction) => ({
    ...correction,
    failReason: correction.failReason ?? null,
    appliedAt: correction.appliedAt ?? null
  }))
  return { ...payload, dbVersion: DB_VERSION, decays, corrections }
}

/** 导入备份：overwrite=true 时先清空全部表，否则按主键合并（同 id 覆盖）；旧版本数据先升级再落库 */
export async function importBackup(
  payload: BackupPayload,
  overwrite: boolean
): Promise<Record<string, number>> {
  const normalized = upgradePayload(payload)
  if (overwrite) await clearAllTables()
  await db.transaction(
    'rw',
    [db.halls, db.elements, db.layers, db.decays, db.repairSteps, db.corrections],
    async () => {
      await db.halls.bulkPut(normalized.halls)
      await db.elements.bulkPut(normalized.elements)
      await db.layers.bulkPut(normalized.layers)
      await db.decays.bulkPut(normalized.decays)
      await db.repairSteps.bulkPut(normalized.repairSteps)
      await db.corrections.bulkPut(normalized.corrections)
    }
  )
  return {
    halls: normalized.halls.length,
    elements: normalized.elements.length,
    layers: normalized.layers.length,
    decays: normalized.decays.length,
    repairSteps: normalized.repairSteps.length,
    corrections: normalized.corrections.length
  }
}

/** 追加式导入：为导入数据重新分配 id，避免覆盖现有档案；校订关系内的引用同步重映射 */
export function remapIds(payload: BackupPayload): BackupPayload {
  const hallIdMap = new Map<string, string>()
  const elementIdMap = new Map<string, string>()
  const layerIdMap = new Map<string, string>()
  const decayIdMap = new Map<string, string>()

  const halls = payload.halls.map((hall) => {
    const id = createId('hall')
    hallIdMap.set(hall.id, id)
    return { ...hall, id }
  })
  const elements = payload.elements.map((element) => {
    const id = createId('elem')
    elementIdMap.set(element.id, id)
    return { ...element, id, hallId: hallIdMap.get(element.hallId) ?? element.hallId }
  })
  const layers = payload.layers.map((layer) => {
    const id = createId('lay')
    layerIdMap.set(layer.id, id)
    return { ...layer, id, elementId: elementIdMap.get(layer.elementId) ?? layer.elementId }
  })
  const decays = payload.decays.map((decay) => {
    const id = createId('dec')
    decayIdMap.set(decay.id, id)
    return { ...decay, id, layerId: layerIdMap.get(decay.layerId) ?? decay.layerId }
  })
  const repairSteps = payload.repairSteps.map((step) => ({
    ...step,
    id: createId('step'),
    decayId: decayIdMap.get(step.decayId) ?? step.decayId
  }))
  const corrections = payload.corrections.map((correction) => ({
    ...correction,
    id: createId('cor'),
    elementId: elementIdMap.get(correction.elementId) ?? correction.elementId,
    // 原层快照：未生效的校订其原层随备份重映射；已生效的原层已不在 layers 表，保留历史 id 备查
    sources: correction.sources.map((source) => ({
      ...source,
      layerId: layerIdMap.get(source.layerId) ?? source.layerId
    })),
    // 目标层位：已生效的随 layers 表重映射；未生效的预生成 id 重新分配，避免重复导入撞号
    targets: correction.targets.map((target) => ({
      ...target,
      layerId: layerIdMap.get(target.layerId) ?? createId('lay')
    })),
    assignments: correction.assignments.map((assignment) => ({
      ...assignment,
      decayId: decayIdMap.get(assignment.decayId) ?? assignment.decayId
    }))
  }))
  return { ...payload, halls, elements, layers, decays, repairSteps, corrections }
}

/** 生成演示样例数据，便于首次打开即可看到完整链路 */
export async function seedDemoData(): Promise<void> {
  const now = Date.now()
  const hallId = createId('hall')
  const elementIds = [createId('elem'), createId('elem')]
  const layerIds = elementIds.map(() => createId('lay'))
  const decayIds = layerIds.map(() => createId('dec'))

  await db.transaction(
    'rw',
    [db.halls, db.elements, db.layers, db.decays, db.repairSteps],
    async () => {
      await db.halls.put({
        id: hallId,
        name: '大雄宝殿',
        era: '明嘉靖',
        structureType: '大木',
        roofType: '庑殿',
        createdAt: now,
        updatedAt: now
      })
      await db.elements.bulkPut([
        {
          id: elementIds[0],
          hallId,
          position: '檐下',
          name: '前檐明间额枋',
          layerCount: 2,
          baseLayer: '一麻五灰',
          status: '待修',
          createdAt: now,
          updatedAt: now
        },
        {
          id: elementIds[1],
          hallId,
          position: '梁枋',
          name: '七架梁',
          layerCount: 1,
          baseLayer: '单披灰',
          status: '观察',
          createdAt: now,
          updatedAt: now
        }
      ])
      await db.layers.bulkPut([
        {
          id: layerIds[0],
          elementId: elementIds[0],
          level: 1,
          patternName: '旋子',
          pigment: '石青',
          thicknessMm: 1.8,
          createdAt: now,
          updatedAt: now
        },
        {
          id: layerIds[1],
          elementId: elementIds[1],
          level: 1,
          patternName: '苏式',
          pigment: '土黄',
          thicknessMm: 1.2,
          createdAt: now,
          updatedAt: now
        }
      ])
      await db.decays.bulkPut([
        {
          id: decayIds[0],
          layerId: layerIds[0],
          type: '起甲',
          severity: '重度',
          areaCm2: 320.5,
          causeGuess: '地仗层脱胶，受檐口渗水影响',
          repaired: false,
          repairedAt: null,
          createdAt: now,
          updatedAt: now
        },
        {
          id: decayIds[1],
          layerId: layerIds[1],
          type: '龟裂',
          severity: '中度',
          areaCm2: 158,
          causeGuess: '木构件干缩引起画面开裂',
          repaired: false,
          repairedAt: null,
          createdAt: now,
          updatedAt: now
        }
      ])
      await db.repairSteps.bulkPut([
        {
          id: createId('step'),
          decayId: decayIds[0],
          seq: 1,
          name: '除尘',
          material: '软毛刷 + 去离子水',
          operator: '李文博',
          state: '已完成',
          createdAt: now,
          updatedAt: now
        },
        {
          id: createId('step'),
          decayId: decayIds[0],
          seq: 2,
          name: '回贴',
          material: '鱼鳔胶（2% 明矾水调和）',
          operator: '李文博',
          state: '进行中',
          createdAt: now,
          updatedAt: now
        }
      ])
    }
  )
}
