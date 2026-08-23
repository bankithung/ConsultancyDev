import { redirect } from 'next/navigation';

/** Moved to `/app/team/[id]` with the rest of the roster. */
export default async function CounselorDetailRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<never> {
  const { id } = await params;
  redirect(`/app/team/${id}`);
}
