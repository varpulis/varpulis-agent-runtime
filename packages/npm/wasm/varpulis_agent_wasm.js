/* @ts-self-types="./varpulis_agent_wasm.d.ts" */

import * as wasm from "./varpulis_agent_wasm_bg.wasm";
import { __wbg_set_wasm } from "./varpulis_agent_wasm_bg.js";
__wbg_set_wasm(wasm);
wasm.__wbindgen_start();
export {
    WasmAgentRuntime
} from "./varpulis_agent_wasm_bg.js";
