// hunt: a quiet placeholder for one follow-up (title, next step, buttons).
export default function FollowupDetailLoading() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6" aria-busy="true" aria-label="Loading">
      <div className="h-4 w-24 rounded bg-surface-hover" />
      <div className="mt-4 h-8 w-48 rounded bg-surface-hover" />
      <div className="mt-6 h-20 rounded-xl bg-surface-hover" />
      <div className="mt-4 flex gap-2"><div className="h-11 w-32 rounded-lg bg-surface-hover" /><div className="h-11 w-24 rounded-lg bg-surface-hover" /></div>
    </div>
  );
}
