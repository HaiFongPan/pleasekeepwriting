import { createHash } from 'node:crypto'
import { Decoder, Profile, Stream } from '@garmin/fitsdk'

export const IDENTITY_VERSION = '1'
const MAX_MESSAGES = 20_000
const MAX_DECODED_CHARS = 4 * 1024 * 1024

export class InvalidFitError extends Error {}
class FileIdentityFallback extends Error {}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

// 使用类型前缀避免数组、对象、字符串和字节数组之间产生编码歧义。
export function canonicalValue(value) {
  if (value === null)
    return 'null'
  if (typeof value === 'string')
    return `s${JSON.stringify(value)}`
  if (typeof value === 'boolean')
    return value ? 'true' : 'false'
  if (typeof value === 'number' && Number.isFinite(value))
    return `n${value}`
  if (Array.isArray(value))
    return `[${value.map(canonicalValue).join(',')}]`
  if (ArrayBuffer.isView(value))
    return `${value.constructor.name}:${canonicalValue(Array.from(value))}`
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalValue(value[key])}`).join(',')}}`
  }
  // 无法无损表达时保守回退，绝不把未知值悄悄转成 null 或空对象。
  throw new FileIdentityFallback()
}

function isWorkOutDoors(message) {
  return message.manufacturer === 'development' && message.productName === 'WorkOutDoors'
}

function stableMessage(number, message) {
  if (number === Profile.MesgNum.FILE_ID && isWorkOutDoors(message)) {
    const { timeCreated, serialNumber, ...stable } = message
    return stable
  }
  if (number === Profile.MesgNum.DEVICE_INFO && message.deviceIndex === 'creator' && isWorkOutDoors(message)) {
    const { timestamp, serialNumber, ...stable } = message
    return stable
  }
  return message
}

export function identifyFit(bytes) {
  const sha256 = digest(bytes)
  const fallback = () => ({
    sha256,
    activityId: digest(`file-v1\0${sha256}`),
    dedupMode: 'file',
    identityVersion: IDENTITY_VERSION,
  })
  const decoder = new Decoder(Stream.fromByteArray(bytes))
  if (bytes.length < 14 || !decoder.checkIntegrity())
    throw new InvalidFitError()
  const hash = createHash('sha256').update('workoutdoors-content-v1\0fitsdk-21.218.0\0')
  let messages = 0
  let decodedChars = 0
  let hasSession = false
  let hasWorkOutDoors = false
  const result = decoder.read({
    includeUnknownData: true,
    convertDateTimesToDates: false,
    convertTypesToStrings: true,
    applyScaleAndOffset: false,
    expandSubFields: false,
    expandComponents: false,
    mergeHeartRates: false,
    decodeMemoGlobs: false,
    mesgDefinitionListener(definition) {
      // SDK 会跳过缺少定义的开发者字段；这类文件暂按完整原件去重。
      if (definition.developerFieldDefinitions?.length)
        throw new FileIdentityFallback()
    },
    mesgListener(number, message) {
      if (++messages > MAX_MESSAGES)
        throw new FileIdentityFallback()
      if (number === Profile.MesgNum.FILE_ID) {
        if (!isWorkOutDoors(message) || message.type !== 'activity')
          throw new FileIdentityFallback()
        hasWorkOutDoors = true
      }
      if (number === Profile.MesgNum.SESSION && Number.isFinite(message.startTime))
        hasSession = true
      const canonical = canonicalValue([number, stableMessage(number, message)])
      decodedChars += canonical.length
      if (decodedChars > MAX_DECODED_CHARS)
        throw new FileIdentityFallback()
      // 逐消息更新摘要，保留跨消息类型的顺序，不额外拼接完整解码树。
      hash.update(canonical).update('\n')
    },
  })
  if (result.errors.some(error => error instanceof FileIdentityFallback))
    return fallback()
  if (result.errors.length)
    throw new InvalidFitError()
  if (!hasWorkOutDoors || !hasSession)
    return fallback()
  return { sha256, activityId: hash.digest('hex'), dedupMode: 'workoutdoors-content', identityVersion: IDENTITY_VERSION }
}

export function archiveKey(identity) {
  return `activities/v1/${identity.activityId}.fit`
}

export function archiveMetadata(identity) {
  return {
    sha256: identity.sha256,
    activityid: identity.activityId,
    identityversion: identity.identityVersion,
    dedupmode: identity.dedupMode,
    publication: 'private',
    source: 'file-upload',
  }
}
