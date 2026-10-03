// @aircloudhq/testing — every error code a capability double may raise or a test may inject.
//
// The platform families come from the errors contracts (generated: contracts/{capability,flex,
// functions,comms}/v1/errors.json); the only additions are the declared, cited mirrors the
// semantics registry names (EXTRA_CODES). A code outside this set is a double defect or a test
// asking the platform to say something it never says, and both are refused.
import { CONTRACT } from "../generated/contract-data.js";
import { EXTRA_CODES } from "./semantics/index.js";

export const KNOWN_CODES = new Set([...CONTRACT.errorCodes, ...EXTRA_CODES]);
