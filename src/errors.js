export class UserError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserError';
  }
}

export function isUnknownChannel(error) {
  return Number(error?.code) === 10003;
}

export function isUnknownMessage(error) {
  return Number(error?.code) === 10008;
}

export function isFullCategory(error) {
  const problems = error?.rawError?.errors?.parent_id?._errors;
  return Number(error?.code) === 50035 && Array.isArray(problems)
    && problems.some((problem) => problem?.code === 'CHANNEL_PARENT_MAX_CHANNELS');
}

export function isServerChannelLimit(error) {
  return Number(error?.code) === 30013;
}
