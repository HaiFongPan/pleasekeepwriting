/** Strava API 原始响应中本站用到的字段，以及站点数据产物格式。 */

export interface StravaPolylineMap {
  id?: string
  /** 完整轨迹，仅详情接口返回 */
  polyline?: string | null
  /** 简化轨迹，列表接口即返回 */
  summary_polyline?: string | null
}

export interface StravaSummaryActivity {
  id: number
  name: string
  /** 已废弃，改用 sport_type */
  type: string
  sport_type: string
  start_date: string
  start_date_local: string
  /** 米 */
  distance: number
  /** 秒 */
  moving_time: number
  /** 秒 */
  elapsed_time: number
  /** 米 */
  total_elevation_gain: number
  average_speed?: number
  max_speed?: number
  average_heartrate?: number
  max_heartrate?: number
  has_heartrate?: boolean
  /** 机械功，列表接口即返回；不等同于卡路里 */
  kilojoules?: number
  device_watts?: boolean
  private?: boolean
  location_city?: string | null
  location_state?: string | null
  location_country?: string | null
  total_photo_count?: number
  map?: StravaPolylineMap
}

export interface StravaDetailedActivity extends StravaSummaryActivity {
  /** 千卡，仅详情接口返回 */
  calories?: number
  description?: string | null
  device_name?: string | null
}

export interface StravaAthlete {
  id: number
  username?: string | null
  firstname?: string | null
  lastname?: string | null
}

/** 运动分组，用于卡片文案与后续筛选 */
export type SportKind = 'ride' | 'run' | 'hike' | 'walk' | 'swim' | 'other'

/**
 * 稳定来源 ID：历史 Strava 活动保留旧的数值 ID，手机 FIT 上传使用归档标识
 * （64 位十六进制字符串，不截断成数字）。轨迹文件名 `${id}.json` 两种都适用。
 */
export type SportActivityId = number | string

/** 活动指标索引：不含任何坐标 */
export interface SportActivity {
  id: SportActivityId
  /** Strava sport_type，例如 Ride / Hike */
  sportType: string
  /** Strava 返回的本地化类型名，例如 骑行 / 高强度间歇训练 */
  displayType: string
  /** Strava 上的活动名称，改过名称时会显示在类型后面 */
  name: string | null
  kind: SportKind
  /**
   * 本地开始时间，以"本地墙上时间当 UTC"的 epoch 表示
   * （取值为训练日志的 start_date_local_raw），排序与展示都用它
   */
  start: number
  /** 本地日期 YYYY-MM-DD */
  date: string
  /** 米 */
  distance: number
  /** 秒 */
  movingTime: number
  /** 秒 */
  elapsedTime: number
  /** 千卡；Strava 口径，来源为原始 FIT 的 session/lap total_calories */
  calories: number | null
  /** 是否已尝试同步卡路里（避免每次同步重复请求拿不到值的老活动） */
  caloriesSynced: boolean
  /** 米 */
  elevation: number | null
  /** 原始文件里是否有 GPS 轨迹 */
  hasGps: boolean
  /** 是否已生成轨迹文件 */
  track: boolean
  /** 是否已尝试同步轨迹 */
  trackSynced: boolean
  /**
   * 时长口径：strava = Strava 的 moving_time；device-timer = 设备写入的
   * total_timer_time。手机上传没有 Strava 的移动时间口径，必须显式标注，
   * 不能把设备计时冒充成 Strava movingTime。历史数据缺省视为 strava。
   */
  timeSource?: 'strava' | 'device-timer'
  /** 数据来源；缺省视为历史 Strava 归档 */
  origin?: 'strava' | 'phone'
}

/** 轨迹渲染参数，变更后需要重建全部轨迹文件 */
export interface SportRenderParams {
  /** 渲染器版本，算法变更时递增 */
  renderer: number
  viewBox: [number, number]
  padding: number
  /** 期望的隐私圈半径，单位米 */
  trimStartMeters: number
  /** 至少保留的里程比例 */
  minRetainRatio: number
  /** 隐私圈半径下限，单位米 */
  minTrimMeters: number
  simplifyTolerance: number
  maxPoints: number
  showMap: boolean
  showLocationNames: boolean
}

export interface SportActivitiesData {
  generatedAt: string
  source: {
    provider: 'strava'
    athleteId: number | null
  }
  params: SportRenderParams
  summary: {
    activityCount: number
    trackCount: number
    calorieMissing: number
    firstActivityAt: string | null
    lastActivityAt: string | null
  }
  activities: SportActivity[]
}

/** 单条轨迹的发布格式：只有归一化后的 SVG 几何，没有经纬度 */
export interface SportTrackFile {
  v: 2
  /** SVG path d，坐标已归一化到 viewBox */
  p: string
  /** 起点，viewBox 坐标 */
  s: [number, number]
  /** 终点，viewBox 坐标 */
  e: [number, number]
  /** 上色指标：speed（快=红/慢=绿）或 grade（上坡=红/下坡=绿） */
  k?: 'speed' | 'grade'
  /** 每段一个 hex 等级（0..f），长度 = 点数 - 1 */
  q?: string
  /** 地图中心经纬度，仅在 showMap 时输出 */
  c?: [number, number]
}
