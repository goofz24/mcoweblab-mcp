/**
 * A mistake in what Claude asked for (an unknown add-on, a size chart that doesn't exist...).
 * The server sends it back as a tool result with isError: true, so Claude can read the
 * message, fix its request and try again, instead of the whole call failing.
 */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolInputError'
  }
}
