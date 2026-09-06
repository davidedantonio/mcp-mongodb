export interface ShutdownLoggerType {
  info: (msg: string) => void
  error: (obj: unknown, msg: string) => void
}

export function shutdownGracefully(
  logger: ShutdownLoggerType,
  close: () => Promise<void>
): void {
  let closging = false

  const shutdown = async (signal: string): Promise<void> => {
    if (closging) {
      logger.info(`Shutdown already in progress, ignoring ${signal}`)
      return
    }

    closging = true
    logger.info(`Received ${signal}, shutting down gracefully...`)

    try {
      await close()
      logger.info('Shutdown complete')
      process.exit(0)
    } catch (error) {
      logger.error(error, 'Error during shutdown')
      process.exit(1)
    }
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}
