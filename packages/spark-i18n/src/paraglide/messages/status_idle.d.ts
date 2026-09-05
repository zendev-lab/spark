/**
* | output |
* | --- |
* | "Idle" |
*
* @param {Status_IdleInputs} inputs
* @param {{ locale?: "en" | "zh-CN" }} options
* @returns {LocalizedString}
*/
export const status_idle: ((inputs?: Status_IdleInputs, options?: {
    locale?: "en" | "zh-CN";
}) => LocalizedString) & import("../runtime.js").MessageMetadata<Status_IdleInputs, {
    locale?: "en" | "zh-CN";
}, {}>;
export type LocalizedString = import("../runtime.js").LocalizedString;
export type Status_IdleInputs = {};
