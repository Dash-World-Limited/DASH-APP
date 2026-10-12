import { SellerItemWorkspace } from '@/components/declutter/SellerHub';
export const metadata = { title: 'Your item — DASH Declutters', robots: { index: false, follow: false } };
export default async function Page({params}:{params:Promise<{submissionId:string}>}) { const {submissionId}=await params; return <SellerItemWorkspace submissionId={submissionId}/>; }
