import { Encoder, Profile } from '@garmin/fitsdk'

// 不含真实运动或位置数据，用于本地及部署验证。
export function createTestFit(options = {}) {
  const {
    exportedAt = new Date('2026-10-15T00:00:00Z'),
    serialNumber = 100,
    productName = 'WorkOutDoors',
    start = new Date('2026-10-14T00:00:00Z'),
    heartRate = 100,
    distance = 1000,
    eventType = 'start',
    sensorSerial = 200,
    sensorTime = start,
    developerVersion = 1,
    includeSession = true,
    records = 1,
  } = options
  const encoder = new Encoder()
  encoder.onMesg(Profile.MesgNum.FILE_ID, {
    manufacturer: 'development',
    productName,
    serialNumber,
    timeCreated: exportedAt,
    type: 'activity',
  })
  encoder.onMesg(Profile.MesgNum.DEVICE_INFO, {
    deviceIndex: 'creator',
    manufacturer: 'development',
    productName,
    serialNumber,
    timestamp: exportedAt,
  })
  encoder.onMesg(Profile.MesgNum.DEVICE_INFO, {
    deviceIndex: 1,
    manufacturer: 'development',
    serialNumber: sensorSerial,
    timestamp: sensorTime,
  })
  encoder.onMesg(Profile.MesgNum.DEVELOPER_DATA_ID, {
    developerDataIndex: 0,
    applicationVersion: developerVersion,
  })
  encoder.onMesg(Profile.MesgNum.EVENT, { timestamp: start, event: 'timer', eventType })
  for (let index = 0; index < records; index++) {
    encoder.onMesg(Profile.MesgNum.RECORD, {
      timestamp: new Date(start.getTime() + index * 1000),
      heartRate,
    })
  }
  encoder.onMesg(Profile.MesgNum.LAP, { startTime: start, totalDistance: distance })
  if (includeSession) {
    encoder.onMesg(Profile.MesgNum.SESSION, {
      startTime: start,
      totalElapsedTime: 600,
      sport: 'running',
      totalDistance: options.sessionDistance ?? distance,
    })
  }
  return encoder.close()
}
