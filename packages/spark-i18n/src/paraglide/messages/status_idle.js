import { getLocale, experimentalStaticLocale } from '../runtime.js';

/** @typedef {import('../runtime.js').LocalizedString} LocalizedString */

/** @typedef {{}} Status_IdleInputs */

const en_status_idle = /** @type {(inputs: Status_IdleInputs) => LocalizedString} */ () => {
	return /** @type {LocalizedString} */ (`Idle`)
};

const zh_cn2_status_idle = /** @type {(inputs: Status_IdleInputs) => LocalizedString} */ () => {
	return /** @type {LocalizedString} */ (`空闲`)
};

/**
* | output |
* | --- |
* | "Idle" |
*
* @param {Status_IdleInputs} inputs
* @param {{ locale?: "en" | "zh-CN" }} options
* @returns {LocalizedString}
*/
export const status_idle = /** @type {((inputs?: Status_IdleInputs, options?: { locale?: "en" | "zh-CN" }) => LocalizedString) & import('../runtime.js').MessageMetadata<Status_IdleInputs, { locale?: "en" | "zh-CN" }, {}>} */ ((inputs = {}, options = {}) => {
	const locale = experimentalStaticLocale ?? options.locale ?? getLocale()
	if (locale === "zh-CN") return zh_cn2_status_idle(inputs)
	return en_status_idle(inputs)
});
