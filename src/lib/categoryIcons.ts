import {
  GraduationCap,
  Dumbbell,
  Coffee,
  ShoppingBag,
  Sprout,
  Lightbulb,
  Crown,
  Globe,
  BookOpen,
  Award,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { EventCategory } from './constants';

export type BadgeType = 'organizer' | 'explorer' | 'study_buddy' | 'team_player' | 'streak_7';

export const CATEGORY_ICONS: Record<EventCategory, LucideIcon> = {
  study: GraduationCap,
  sports: Dumbbell,
  social: Coffee,
  shopping: ShoppingBag,
  volunteering: Sprout,
  other: Lightbulb,
};

export const BADGE_ICONS: Record<BadgeType, LucideIcon> = {
  organizer: Crown,
  explorer: Globe,
  study_buddy: BookOpen,
  team_player: Award,
  streak_7: Zap,
};

// SVG strings used by Mapbox DOM markers (React components cannot be used there)
const s = (paths: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16">${paths}</svg>`;

const CATEGORY_MARKER_SVG: Record<EventCategory, string> = {
  study: s(
    `<path d="M21.42 10.922a1 1 0 0 0-.019-1.838L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.832l8.57 3.908a2 2 0 0 0 1.66 0z"/>` +
    `<path d="M22 10v6"/>` +
    `<path d="M6 12.5V16a6 3 0 0 0 12 0v-3.5"/>`,
  ),
  sports: s(
    `<path d="M14.4 14.4 9.6 9.6"/>` +
    `<path d="M18.657 21.485a2 2 0 1 1-2.829-2.828l-1.767 1.768a2 2 0 1 1-2.829-2.829l6.364-6.364a2 2 0 1 1 2.829 2.829l-1.768 1.767a2 2 0 1 1 2.828 2.829z"/>` +
    `<path d="m21.5 21.5-1.4-1.4"/>` +
    `<path d="M3.9 3.9 2.5 2.5"/>` +
    `<path d="M6.404 12.768a2 2 0 1 1-2.829-2.829l1.768-1.767a2 2 0 1 1-2.828-2.829l2.828-2.828a2 2 0 1 1 2.829 2.828l1.767-1.768a2 2 0 1 1 2.829 2.829z"/>`,
  ),
  social: s(
    `<path d="M10 2v2"/>` +
    `<path d="M14 2v2"/>` +
    `<path d="M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1"/>` +
    `<path d="M6 2v2"/>`,
  ),
  shopping: s(
    `<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/>` +
    `<path d="M3 6h18"/>` +
    `<path d="M16 10a4 4 0 0 1-8 0"/>`,
  ),
  volunteering: s(
    `<path d="M7 20h10"/>` +
    `<path d="M10 20c5.5-2.5.8-6.4 3-10"/>` +
    `<path d="M9.5 9.4c1.1.8 1.8 2.2 2.3 3.7-2 .4-3.5.4-4.8-.3-1.2-.6-2.3-1.9-3-4.2 2.8-.5 4.4 0 5.5.8z"/>` +
    `<path d="M14.1 6a7 7 0 0 0-1.1 4c1.9-.1 3.3-.6 4.3-1.4 1-1 1.6-2.3 1.7-4.6-2.7.1-4 1-4.9 2z"/>`,
  ),
  other: s(
    `<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/>` +
    `<path d="M9 18h6"/>` +
    `<path d="M10 22h4"/>`,
  ),
};

export function getCategoryMarkerSVG(category: string): string {
  return CATEGORY_MARKER_SVG[category as EventCategory] ?? CATEGORY_MARKER_SVG.other;
}
