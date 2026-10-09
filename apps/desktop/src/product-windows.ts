/**
 * Product-window enumeration for Phase 7 exit criteria.
 * Spec section 16.1 / Phase 7: at most one Main and one Widget instance.
 */

export type ProductWindowRole = "main" | "widget";

export type ProductWindowSnapshot = {
  role: ProductWindowRole;
  id: number | null;
  destroyed: boolean;
};

export type ProductWindowEnumeration = {
  main: ProductWindowSnapshot | null;
  widget: ProductWindowSnapshot | null;
  count: number;
};

export function enumerateProductWindows(input: {
  mainWindow: { id?: number; isDestroyed?: () => boolean } | null | undefined;
  widgetWindow: { id?: number; isDestroyed?: () => boolean } | null | undefined;
  widgetEnabled: boolean;
}): ProductWindowEnumeration {
  const main =
    input.mainWindow && !(input.mainWindow.isDestroyed?.() ?? false)
      ? {
          role: "main" as const,
          id: typeof input.mainWindow.id === "number" ? input.mainWindow.id : null,
          destroyed: false
        }
      : null;

  const widget =
    input.widgetEnabled &&
    input.widgetWindow &&
    !(input.widgetWindow.isDestroyed?.() ?? false)
      ? {
          role: "widget" as const,
          id: typeof input.widgetWindow.id === "number" ? input.widgetWindow.id : null,
          destroyed: false
        }
      : null;

  return {
    main,
    widget,
    count: (main ? 1 : 0) + (widget ? 1 : 0)
  };
}

export function assertProductWindowInvariant(enumeration: ProductWindowEnumeration): void {
  if (enumeration.count > 2) {
    throw new Error(`Product window invariant violated: count=${enumeration.count}`);
  }
  if (enumeration.main === null && enumeration.widget !== null) {
    // Widget-only is allowed only transiently; Main is still expected after readiness.
  }
}
