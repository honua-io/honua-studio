export interface SourceConsumer {
  readonly id: string;
  readonly sourceId?: string;
}

export interface SourceUseComposition {
  readonly layers: readonly { readonly id: string; readonly sourceId?: string }[];
  readonly controls?: readonly SourceConsumer[];
  readonly widgets?: readonly SourceConsumer[];
}

export interface LayerRemovalBlocker {
  readonly role: "control" | "widget";
  readonly consumerId: string;
  readonly sourceId: string;
  readonly message: string;
}

export function layerRemovalBlocker(
  composition: SourceUseComposition,
  layerId: string,
): LayerRemovalBlocker | undefined;
