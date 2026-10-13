/**
 * 最小 FIT 解析器：只为从原始活动文件里取会话汇总（卡路里 / 距离 / 时长）。
 *
 * FIT 是二进制格式，完整规范见 https://developer.garmin.com/fit/protocol/。
 * 这里只实现解析所需的子集：文件头、definition message、data message、
 * 压缩时间戳记录、开发者字段跳过；不做 CRC 校验。
 *
 * 取值口径提醒：这是设备（手表/码表）写入的 total_calories，
 * 可能与 strava.com 页面上显示的 Strava 计算值不完全一致。
 */

import { gunzipSync } from 'node:zlib'

export interface FitSummary {
  /** 千卡，设备口径 */
  totalCalories: number | null
  /** 米 */
  totalDistanceMeters: number | null
  /** 秒，含暂停 */
  totalElapsedSeconds: number | null
  /** 秒，不含暂停 */
  totalTimerSeconds: number | null
  /** 次/分 */
  averageHeartRate: number | null
}

interface FieldDefinition {
  num: number
  size: number
}

interface MessageDefinition {
  globalNum: number
  bigEndian: boolean
  fields: FieldDefinition[]
}

const fitMagic = '.FIT'
const lapMessageNum = 19
const sessionMessageNum = 18

/** FIT 里的无效值哨兵 */
function isInvalid(value: number, size: number): boolean {
  if (size === 2) {
    return value >= 0xFFFF
  }

  if (size === 4) {
    return value >= 0xFFFFFFFE
  }

  return value === 0xFF
}

/** 解压（如果是 gzip）并校验 FIT magic */
export function normalizeFitBuffer(input: Uint8Array): Uint8Array {
  if (input[0] === 0x1F && input[1] === 0x8B) {
    return new Uint8Array(gunzipSync(input))
  }

  return input
}

function readUint(view: DataView, offset: number, size: number, bigEndian: boolean): number {
  if (size === 1) {
    return view.getUint8(offset)
  }

  if (size === 2) {
    return view.getUint16(offset, !bigEndian)
  }

  if (size === 4) {
    return view.getUint32(offset, !bigEndian)
  }

  return 0
}

/**
 * 读取 FIT 文件里的汇总。卡路里优先取 session.total_calories(13)，
 * 缺失时回退到 lap.total_calories(11) 的累加。
 * @returns 不是合法 FIT 或没解析到 session 时返回 null
 */
export function readFitSummary(input: Uint8Array): FitSummary | null {
  const buffer = normalizeFitBuffer(input)
  if (buffer.length < 14) {
    return null
  }

  const headerSize = buffer[0]
  const magic = String.fromCharCode(...buffer.slice(8, 12))
  if (headerSize < 12 || magic !== fitMagic || buffer.length < headerSize) {
    return null
  }

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const dataSize = view.getUint32(4, true)
  const dataEnd = Math.min(buffer.length, headerSize + dataSize)

  const definitions = new Map<number, MessageDefinition>()
  const session: FitSummary = {
    totalCalories: null,
    totalDistanceMeters: null,
    totalElapsedSeconds: null,
    totalTimerSeconds: null,
    averageHeartRate: null,
  }
  let lapCalories = 0
  let cursor = headerSize

  while (cursor < dataEnd) {
    const header = buffer[cursor++]
    const localType = header & 0x0F

    // 压缩时间戳头：不重新定义字段，且数据里省略 timestamp(253) 字段
    if (header & 0x80) {
      const definition = definitions.get(localType)
      if (!definition) {
        break
      }

      const payloadSize = definition.fields
        .filter(field => field.num !== 253)
        .reduce((sum, field) => sum + field.size, 0)
      cursor += payloadSize
      continue
    }

    // definition message
    if (header & 0x40) {
      const hasDeveloperFields = (header & 0x20) !== 0
      cursor++ // reserved
      const bigEndian = buffer[cursor++] === 1
      const globalNum = readUint(view, cursor, 2, bigEndian)
      cursor += 2
      const fieldCount = buffer[cursor++]
      const fields: FieldDefinition[] = []
      for (let index = 0; index < fieldCount; index++) {
        const num = buffer[cursor++]
        const size = buffer[cursor++]
        cursor++ // base_type，跳过时用 size 即可
        fields.push({ num, size })
      }

      if (hasDeveloperFields) {
        const developerFieldCount = buffer[cursor++]
        for (let index = 0; index < developerFieldCount; index++) {
          cursor++ // field num
          cursor++ // size
          cursor++ // developer data index
        }
      }

      definitions.set(localType, { globalNum, bigEndian, fields })
      continue
    }

    // data message
    const definition = definitions.get(localType)
    if (!definition) {
      break
    }

    const isSession = definition.globalNum === sessionMessageNum
    const isLap = definition.globalNum === lapMessageNum

    if (isSession || isLap) {
      let fieldOffset = cursor
      for (const field of definition.fields) {
        const value = readUint(view, fieldOffset, field.size, definition.bigEndian)
        const valid = !isInvalid(value, field.size)

        if (isSession && valid) {
          switch (field.num) {
            case 7: // total_elapsed_time，单位 1/1000 秒
              session.totalElapsedSeconds = value / 1000
              break
            case 8: // total_timer_time，单位 1/1000 秒
              session.totalTimerSeconds = value / 1000
              break
            case 9: // total_distance，单位 1/100 米
              session.totalDistanceMeters = value / 100
              break
            case 13: // total_calories，千卡
              session.totalCalories = value
              break
            case 16: // avg_heart_rate
              session.averageHeartRate = value
              break
            default:
              break
          }
        }
        else if (isLap && valid && field.num === 11) {
          // lap 的 total_calories
          lapCalories += value
        }

        fieldOffset += field.size
      }

      // lap 消息在 session 之前，因此这里已经累加完毕
      if (isSession) {
        if (session.totalCalories == null && lapCalories > 0) {
          session.totalCalories = lapCalories
        }

        return session
      }
    }

    cursor += definition.fields.reduce((sum, field) => sum + field.size, 0)
  }

  // 只有 lap 没有 session 的异常文件
  if (lapCalories > 0) {
    return { ...session, totalCalories: lapCalories }
  }

  return null
}

/** 诊断用：列出文件里出现过的消息类型与字段号 */
export function describeFitMessages(input: Uint8Array): Array<{ globalNum: number, fieldNums: number[] }> {
  const buffer = normalizeFitBuffer(input)
  if (buffer.length < 14 || String.fromCharCode(...buffer.slice(8, 12)) !== fitMagic) {
    return []
  }

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const dataEnd = Math.min(buffer.length, buffer[0] + view.getUint32(4, true))
  const definitions = new Map<number, MessageDefinition>()
  const seen = new Map<number, number[]>()
  let cursor = buffer[0]

  while (cursor < dataEnd) {
    const header = buffer[cursor++]
    const localType = header & 0x0F

    if (header & 0x80) {
      const definition = definitions.get(localType)
      if (!definition) {
        break
      }

      cursor += definition.fields.filter(field => field.num !== 253).reduce((sum, field) => sum + field.size, 0)
      continue
    }

    if (header & 0x40) {
      const hasDeveloperFields = (header & 0x20) !== 0
      cursor++
      const bigEndian = buffer[cursor++] === 1
      const globalNum = readUint(view, cursor, 2, bigEndian)
      cursor += 2
      const fieldCount = buffer[cursor++]
      const fields: FieldDefinition[] = []
      for (let index = 0; index < fieldCount; index++) {
        const num = buffer[cursor++]
        const size = buffer[cursor++]
        cursor++
        fields.push({ num, size })
      }

      if (hasDeveloperFields) {
        const developerFieldCount = buffer[cursor++]
        cursor += developerFieldCount * 3
      }

      definitions.set(localType, { globalNum, bigEndian, fields })
      if (!seen.has(globalNum)) {
        seen.set(globalNum, fields.map(field => field.num))
      }

      continue
    }

    const definition = definitions.get(localType)
    if (!definition) {
      break
    }

    cursor += definition.fields.reduce((sum, field) => sum + field.size, 0)
  }

  return [...seen.entries()].map(([globalNum, fieldNums]) => ({ globalNum, fieldNums }))
}
