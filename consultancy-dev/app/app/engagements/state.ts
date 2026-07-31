import { format, startOfMonth } from 'date-fns';

import type { FilterSelection } from '@/components/common/FilterDrawer';

/**
 * PER-TAB QUERY STATE.
 *
 * The two tabs query different endpoints with different vocabularies, so one
 * shared bag would send `priority` to the appointments endpoint — where DRF
 * drops keys it does not recognise and hands back an unfiltered list that looks
 * filtered. Keeping a record per tab is also what stops a search typed on one
 * tab from silently narrowing the other when you switch back.
 *
 * It is held by the page rather than by each view because only the ACTIVE view
 * is mounted; state inside an unmounted view would be lost on every switch.
 */
export interface EngagementTabState {
  /** What is in the search box right now. */
  search: string;
  /** The term the queries actually run with — `search`, debounced. */
  committed: string;
  selection: FilterSelection;
  page: number;
  /** The row whose detail panel is open, or null. */
  selectedId: number | null;
  /** Which filter category the drawer opens on. */
  activeParam: string;
  /**
   * The `[committed, selection]` pair `page` was computed for.
   *
   * Remembered per tab so that switching tabs — which changes nothing about
   * either tab's query — does not reset the cursor of the tab being opened.
   */
  shape: string;
}

export interface AppointmentsTabState extends EngagementTabState {
  mode: 'calendar' | 'list';
  /** First day of the month on screen, `yyyy-MM-dd`. */
  month: string;
  /** The day whose schedule is open, `yyyy-MM-dd`. */
  day: string;
}

export interface EngagementsState {
  'follow-ups': EngagementTabState;
  appointments: AppointmentsTabState;
}

/** An empty selection and an empty search — the shape they hash to. */
const EMPTY_SHAPE = JSON.stringify(['', {}]);

export function createInitialState(): EngagementsState {
  const today = new Date();
  return {
    'follow-ups': {
      search: '',
      committed: '',
      selection: {},
      page: 1,
      selectedId: null,
      activeParam: 'status',
      shape: EMPTY_SHAPE,
    },
    appointments: {
      search: '',
      committed: '',
      selection: {},
      page: 1,
      selectedId: null,
      activeParam: 'status',
      shape: EMPTY_SHAPE,
      mode: 'calendar',
      month: format(startOfMonth(today), 'yyyy-MM-dd'),
      day: format(today, 'yyyy-MM-dd'),
    },
  };
}
