/** Registers every dictionary. Import this once, at the shell's entry, before
 *  anything calls `t()`. */
import { registerLocale } from "../i18n";
import { zh } from "./zh";

registerLocale("zh", zh);
