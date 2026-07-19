// Planning-grade construction cost ranges shown live in the editor — copy of
// bikenetwork/costs.py (path type -> [low, high] $ per corridor-mile). If you
// adjust one copy, adjust the other, or the two editors' estimates disagree.
export const COST_PER_MILE = {
  quick_build_separated: [150_000, 500_000],
  concrete_separated: [1_000_000, 3_500_000],
  shared_use_path: [1_000_000, 3_000_000],
  buffered_painted: [50_000, 150_000],
  neighborway: [50_000, 250_000],
};
