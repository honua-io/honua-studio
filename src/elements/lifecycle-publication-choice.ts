import type { StudioPublicationIntent } from "../lifecycle/lifecycle-types.js";

/** The visibilities the server accepts for a publication. None is preselected: the person publishing chooses. */
export const PUBLICATION_VISIBILITIES = ["personal", "team", "organization", "public"] as const;

/** A person's route and visibility choice for a saved version that carries no publication intent. */
export interface PublicationChoice {
  readonly route: string;
  readonly visibility: string;
}

export function suggestedPublicationChoice(contentKey: string | undefined): PublicationChoice {
  return { route: contentKey ? `/${contentKey}` : "", visibility: "" };
}

/** The intent a complete, valid choice publishes; `undefined` until the route and visibility are both valid. */
export function intentFromChoice(choice: PublicationChoice): StudioPublicationIntent | undefined {
  const route = choice.route.trim();
  const routeIsValid = route.startsWith("/") && !/\s/.test(route);
  const visibilityIsValid = (PUBLICATION_VISIBILITIES as readonly string[]).includes(choice.visibility);
  return routeIsValid && visibilityIsValid ? { route, visibility: choice.visibility } : undefined;
}
