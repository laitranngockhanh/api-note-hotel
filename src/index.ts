import { readEnv } from './env'
import { createApp } from './app'
import { connect } from './db/client'
import { createPinCodec } from './lib/pin'

const env = readEnv()
const { db } = await connect(env.databaseUrl, env.dataDir)

const app = createApp(
  { db, pins: createPinCodec(env.pinSecret), now: () => new Date(), setupCode: env.setupCode },
  env.corsOrigins,
)
app.listen(env.port, () => {
  console.log(`API chạy ở http://localhost:${env.port}/api (${env.databaseUrl ? 'PostgreSQL' : `PGlite trong thư mục ${env.dataDir}`})`)
})
