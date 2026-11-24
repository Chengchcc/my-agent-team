import Link from "next/link";
import { Page, PageBody, PageHeader } from "@/components/page";
import { buttonVariants } from "@/components/ui/button";

/** A missing page inside the console keeps the console (a review measured the
 *  default white 404 as "no shell, no way back"). */
export default function NotFound() {
  return (
    <Page>
      <PageHeader title="Not found" description="Nothing lives at this address." />
      <PageBody>
        <Link href="/today" className={buttonVariants({ variant: "outline", size: "sm" })}>
          Back to Today
        </Link>
      </PageBody>
    </Page>
  );
}
