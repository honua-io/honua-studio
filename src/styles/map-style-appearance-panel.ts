import {
  MAX_STROKE_OR_SIZE_PX,
  type MapStyleAppearancePatch,
  type MapStyleAppearanceProperty,
  type MapStyleDocument,
  type MapStyleLayerOwner,
  type MapStyleLegendEntry,
  layerAppearance,
} from "./map-style-edit.js";

const PERCENT = 100;

export function labelled(text: string | HTMLElement, control: HTMLElement): HTMLLabelElement {
  const label = document.createElement("label");
  label.append(text, " ", control);
  return label;
}

/** Color, opacity and size or width for the selected layer; expressions and functions stay read-only. */
export class MapStyleAppearancePanel {
  readonly element = document.createElement("fieldset");
  readonly #color = document.createElement("input");
  readonly #opacity = document.createElement("input");
  readonly #opacityValue = document.createElement("output");
  readonly #size = document.createElement("input");
  readonly #sizeText = document.createElement("span");
  readonly #sizeLabel = labelled(this.#sizeText, this.#size);
  readonly #hint = document.createElement("p");

  constructor(onPatch: (patch: MapStyleAppearancePatch) => void) {
    const legend = document.createElement("legend");
    legend.textContent = "Appearance";
    this.#color.type = "color";
    Object.assign(this.#opacity, { type: "range", min: "0", max: String(PERCENT), step: "5" });
    this.#opacityValue.setAttribute("aria-hidden", "true");
    Object.assign(this.#size, { type: "number", min: "0", max: String(MAX_STROKE_OR_SIZE_PX), step: "0.5" });
    this.#color.addEventListener("input", () => onPatch({ color: this.#color.value }));
    this.#opacity.addEventListener("input", () => {
      this.#showOpacityValue();
      onPatch({ opacity: Number(this.#opacity.value) / PERCENT });
    });
    this.#size.addEventListener("input", () => {
      if (this.#size.value.trim() !== "") onPatch({ strokeOrSize: Number(this.#size.value) });
    });
    const opacityLabel = labelled("Opacity", this.#opacity);
    opacityLabel.append(" ", this.#opacityValue);
    this.element.append(legend, labelled("Color", this.#color), opacityLabel, this.#sizeLabel, this.#hint);
  }

  sync(style: MapStyleDocument, owner: MapStyleLayerOwner | undefined): void {
    const appearance = owner ? layerAppearance(style, owner) : undefined;
    this.element.disabled = !appearance;
    if (!appearance) {
      this.#hint.textContent = "This layer has no point, line or polygon render layer. Add one in the advanced editor.";
      return;
    }
    const refusals = new Set<string>();
    const show = (input: HTMLInputElement, property: MapStyleAppearanceProperty | undefined, value: string) => {
      input.disabled = !property || Boolean(property.refusal);
      if (property?.refusal) refusals.add(property.refusal);
      if (!input.matches(":focus")) input.value = value;
    };
    const color = appearance.color.value;
    const hexColor = typeof color === "string" && /^#[a-fA-F0-9]{6}$/i.test(color);
    show(this.#color, appearance.color, hexColor ? color : "#000000");
    if (typeof color === "string" && !hexColor)
      refusals.add(`Current color ${color} has no exact swatch; choosing a color replaces it.`);
    const opacity = typeof appearance.opacity.value === "number" ? appearance.opacity.value : 1;
    show(this.#opacity, appearance.opacity, String(Math.round(opacity * PERCENT)));
    this.#showOpacityValue();
    const stroke = appearance.strokeOrSize;
    this.#sizeText.textContent = { circle: "Point size (px)", line: "Line width (px)", fill: "Outline width (px)" }[
      appearance.geometry
    ];
    this.#sizeLabel.hidden = !stroke;
    show(this.#size, stroke, typeof stroke?.value === "number" ? String(stroke.value) : "");
    this.#hint.textContent = [...refusals].join(" ");
  }

  #showOpacityValue(): void {
    this.#opacityValue.value = `${this.#opacity.value}%`;
    this.#opacity.setAttribute("aria-valuetext", this.#opacityValue.value);
  }
}

/** The legend of the last thematic preview per layer, shown while the painted expression is still that preview. */
export class ThematicLegendPreview {
  readonly element = document.createElement("ul");
  readonly #legends = new Map<
    string,
    { readonly expression: string; readonly entries: readonly MapStyleLegendEntry[] }
  >();

  constructor() {
    this.element.setAttribute("aria-label", "Legend preview");
    this.element.dataset.testid = "map-style-legend";
    this.element.hidden = true;
  }

  remember(ownerId: string, expression: string, entries: readonly MapStyleLegendEntry[]): void {
    this.#legends.set(ownerId, { expression, entries });
  }

  render(ownerId: string | undefined, paintedExpression: string | undefined): void {
    const legend = ownerId ? this.#legends.get(ownerId) : undefined;
    this.element.replaceChildren();
    this.element.hidden = !legend || legend.expression !== paintedExpression;
    if (this.element.hidden || !legend) return;
    for (const entry of legend.entries) {
      const item = document.createElement("li");
      const swatch = document.createElement("span");
      swatch.setAttribute("aria-hidden", "true");
      swatch.style.cssText = `display:inline-block;width:1em;height:1em;margin-inline-end:.4em;vertical-align:middle;border:1px solid #0003;background:${entry.color}`;
      item.dataset.color = entry.color;
      item.append(swatch, entry.label);
      this.element.append(item);
    }
  }
}
