/**
 * 供应商密钥文件：<workspaceDir>/providers.json（权限 600）。
 *
 * 工作台「设置」抽屉写入这里；优先级低于 cordis.patch.yml 与环境变量，
 * 高于「未配置」。文件缺失/损坏时按空配置处理，不阻断启动。
 * @module providers/file-store
 */
import { readFileSync, renameSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

/** 允许写入的供应商 id。 */
export const PROVIDER_IDS = Object.freeze(['jimeng', 'doubaoSeedream', 'doubaoSeedance', 'wanx', 'tongyiWanx', 'kling'])

/** 每家允许的凭据字段。 */
export const PROVIDER_FIELDS = Object.freeze({
  jimeng: ['apiKey'],
  doubaoSeedream: ['apiKey'],
  doubaoSeedance: ['apiKey'],
  wanx: ['apiKey'],
  tongyiWanx: ['apiKey'],
  kling: ['accessKey', 'secretKey'],
})

export function providersFilePath(workspaceDir) {
  return join(workspaceDir, 'providers.json')
}

/** 读取密钥文件（失败返回空对象）。 */
export function readProvidersFile(workspaceDir) {
  try {
    const parsed = JSON.parse(readFileSync(providersFilePath(workspaceDir), 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed
  } catch {
    return {}
  }
}

/** 原子写入。 */
function writeProvidersFile(workspaceDir, data) {
  mkdirSync(workspaceDir, { recursive: true })
  const target = providersFilePath(workspaceDir)
  const temporary = `${target}.${randomUUID()}.tmp`
  writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  chmodSync(temporary, 0o600)
  renameSync(temporary, target)
}

/**
 * 保存/更新一家的凭据（合并写入，不覆盖其他家）。
 * @param {string} workspaceDir
 * @param {string} providerId
 * @param {Record<string, string>} fields
 */
export function saveProviderSecret(workspaceDir, providerId, fields) {
  if (!PROVIDER_IDS.includes(providerId)) throw new Error(`未知供应商 ${providerId}`)
  const allowed = PROVIDER_FIELDS[providerId]
  const current = readProvidersFile(workspaceDir)
  const entry = current !== null && typeof current[providerId] === 'object' && current[providerId] !== null
    ? { ...current[providerId] }
    : {}
  for (const key of allowed) {
    const value = fields?.[key]
    if (typeof value === 'string' && value.trim() !== '') entry[key] = value.trim()
  }
  writeProvidersFile(workspaceDir, { ...current, [providerId]: entry })
  return entry
}

/** 清除一家（保留其他家）。 */
export function removeProviderSecret(workspaceDir, providerId) {
  if (!PROVIDER_IDS.includes(providerId)) throw new Error(`未知供应商 ${providerId}`)
  const current = readProvidersFile(workspaceDir)
  delete current[providerId]
  writeProvidersFile(workspaceDir, current)
}

/** 掩码：只露前 4 后 4，短 key 全遮。 */
export function maskSecret(value) {
  const text = String(value ?? '')
  if (text === '') return ''
  if (text.length <= 10) return '••••••'
  return `${text.slice(0, 4)}…${text.slice(-4)}`
}
