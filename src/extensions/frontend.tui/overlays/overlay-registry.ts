import type { OverlayDescriptor } from './overlay-types'
import { overlayPermission } from './impls/overlay-permission/overlay-permission'
import { overlayAskUserQuestion } from './impls/overlay-ask-user-question/overlay-ask-user-question'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- overlay descriptor type parameters vary per implementation
export const OVERLAYS: ReadonlyArray<OverlayDescriptor<any, any>> = [overlayPermission, overlayAskUserQuestion]
