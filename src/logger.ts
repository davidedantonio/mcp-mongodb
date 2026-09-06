import pino, { type LevelWithSilent, type Logger } from 'pino'

export interface LoggerOptions {
  level?: LevelWithSilent
  name?: string
}

export function createLogger({
  level = 'info',
  name = 'mongodb-mcp-server'
}: LoggerOptions = {}): Logger {
  return pino(
    {
      level,
      name,

      timestamp: pino.stdTimeFunctions.isoTime,
      base: undefined, // Remove pid and hostname from the log output

      redact: {
        paths: [
          'MONGODB_URI',
          'env.MONGODB_URI',
          'password',
          'token',
          'authorization',
          'headers.authorization'
        ],
        censor: '[REDACTED]'
      }
    },

    // log only on stderr
    pino.destination({
      dest: 2,
      sync: true
    })
  )
}
