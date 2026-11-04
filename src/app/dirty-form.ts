/** Elements with their own draft lifecycle; their inputs never count as unsaved workspace edits. */
const SELF_MANAGED_TAGS = new Set(["HONUA-STUDIO-CHAT", "HONUA-STUDIO-CONTROL-BAR"]);

function isEditedSelect(select: HTMLSelectElement): boolean {
  const explicitDefault = [...select.options].some((option) => option.defaultSelected);
  return [...select.options].some(
    (option, index) =>
      option.selected !== (option.defaultSelected || (!explicitDefault && !select.multiple && index === 0)),
  );
}

function isEditedControl(element: Element): boolean {
  if (element instanceof HTMLInputElement) {
    const checkable = element.type === "checkbox" || element.type === "radio";
    if (checkable ? element.checked !== element.defaultChecked : element.value !== element.defaultValue) return true;
  } else if (element instanceof HTMLTextAreaElement && element.value !== element.defaultValue) return true;
  if (element instanceof HTMLSelectElement && isEditedSelect(element)) return true;
  return element instanceof HTMLElement && element.isContentEditable;
}

/** True when any form control under `root`, including nested shadow roots, differs from its default. */
export function hasEditedFormControl(root: ParentNode, isIgnored: (element: Element) => boolean): boolean {
  for (const element of root.querySelectorAll("*")) {
    if (SELF_MANAGED_TAGS.has(element.tagName) || isIgnored(element)) continue;
    if (isEditedControl(element)) return true;
    if (element.shadowRoot && hasEditedFormControl(element.shadowRoot, isIgnored)) return true;
  }
  return false;
}
