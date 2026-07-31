import { notFound } from 'next/navigation';
import { StudentProfileView } from '../../components/StudentProfileView';
import { isProfileType } from '../../constants';

interface PageProps {
  params: Promise<{ type: string; id: string }>;
}

export default async function StudentProfilePage({ params }: PageProps) {
  const { type, id } = await params;

  // The old build passed `type` straight through as a string and let the view
  // fall through to "Record not found". A bad segment is a bad URL, so it gets
  // the 404 it deserves and the view can take a narrowed union.
  if (!isProfileType(type) || !id) notFound();

  return <StudentProfileView type={type} id={id} />;
}
