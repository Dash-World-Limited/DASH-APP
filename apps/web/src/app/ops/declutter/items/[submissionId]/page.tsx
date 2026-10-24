import { OpsHubAccess, OpsItemWorkspace } from '@/components/declutter/OpsHub';
export default async function Page({params}:{params:Promise<{submissionId:string}>}) { const {submissionId}=await params;return <OpsHubAccess><OpsItemWorkspace submissionId={submissionId}/></OpsHubAccess>; }
