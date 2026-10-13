/** An error with an HTTP status, whose message is shown to the user as-is. */
class ApiError extends Error {
  constructor(status, message, details = {}) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

module.exports = { ApiError };
