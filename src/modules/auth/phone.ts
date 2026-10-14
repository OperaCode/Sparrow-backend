const SEPARATORS = /[\s\-()]/g;

/**
 * Nigerian mobile numbers are 10 digits after the country code and start
 * with 70, 80, 81, 90 or 91. Landlines and the "+2340..." mistake, where the
 * trunk zero is kept after the country code, are rejected rather than
 * guessed at.
 */
const NIGERIAN_MOBILE = /^(?:\+234|234|0)((?:70|80|81|90|91)[0-9]{8})$/;

/**
 * Returns the number in E.164 form (+234 followed by 10 digits), or null if
 * it is not a Nigerian mobile number.
 */
export function normaliseNigerianMobile(input: string): string | null {
  const subscriber = NIGERIAN_MOBILE.exec(input.replace(SEPARATORS, ''))?.[1];
  return subscriber === undefined ? null : `+234${subscriber}`;
}
