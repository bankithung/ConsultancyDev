import { create } from 'zustand';

interface UIState {
  pageTitle: string | null;
  setPageTitle: (title: string | null) => void;
}

export const useUIStore = create<UIState>((set) => ({
  pageTitle: null,
  setPageTitle: (title) => set({ pageTitle: title }),
}));
