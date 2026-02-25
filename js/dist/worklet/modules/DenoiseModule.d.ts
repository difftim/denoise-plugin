import type { DenoiseModuleId } from "../../options";
import { AudioProcessingModule } from "./AudioProcessingModule";
export declare abstract class DenoiseModule<TConfig> extends AudioProcessingModule<TConfig> {
    abstract readonly moduleId: DenoiseModuleId;
}
