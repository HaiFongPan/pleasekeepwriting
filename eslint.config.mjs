import antfu from '@antfu/eslint-config'

export default antfu({
  typescript: true,
  astro: true,
  unocss: true,
  // 同步脚本生成的轨迹数据是给浏览器读的紧凑 JSON，不参与代码风格检查
  ignores: ['public/strava/tracks/**'],
})
