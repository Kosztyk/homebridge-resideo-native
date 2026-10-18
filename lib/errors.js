'use strict';

class ResideoError extends Error {
  constructor(message, code = 'resideo_error') {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
  }
}
class AuthenticationError extends ResideoError {
  constructor(message = 'Sign in to Resideo in the plugin settings, then restart Homebridge.') {
    super(message, 'authentication_required');
  }
}
class InteractionRequired extends ResideoError {
  constructor(message = 'Resideo requires browser sign-in to complete verification or other account prompts.') {
    super(message, 'interaction_required');
  }
}
class InvalidCallback extends ResideoError {
  constructor(message = 'Paste the complete Resideo callback URL from this sign-in attempt.') {
    super(message, 'invalid_callback');
  }
}
class CannotConnect extends ResideoError {
  constructor(message = 'Cannot connect to Resideo. Check the connection and try again.') {
    super(message, 'cannot_connect');
  }
}
class InvalidResponse extends ResideoError {
  constructor(message = 'Resideo returned an unexpected response.') {
    super(message, 'invalid_response');
  }
}
class CommandError extends ResideoError {
  constructor(message) { super(message, 'command_rejected'); }
}
class RateLimited extends ResideoError {
  constructor(seconds) {
    super(`Resideo is limiting requests. Try again in ${Math.ceil(seconds)} seconds.`, 'rate_limited');
    this.retryAfter = seconds;
  }
}
function safeMessage(error) {
  return error instanceof ResideoError ? error.message : 'The operation failed. Check the Homebridge storage permissions and try again.';
}
module.exports = { ResideoError, AuthenticationError, InteractionRequired, InvalidCallback, CannotConnect, InvalidResponse, CommandError, RateLimited, safeMessage };
