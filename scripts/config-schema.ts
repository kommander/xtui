import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { XTUI_CONFIG_JSON_SCHEMA } from "../src/config.js"

writeFileSync(join(import.meta.dir, "..", "xtui.schema.json"), `${JSON.stringify(XTUI_CONFIG_JSON_SCHEMA, null, 2)}\n`)
