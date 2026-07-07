import { SkillPackManager } from "@/components/SkillPackManager";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@/components/ui/breadcrumb";

export default function SkillPacksPage() {
  return (
    <div className="h-full bg-[var(--canvas)]">
      <div className="border-b border-[var(--hairline)]">
        <div className="container mx-auto px-8 py-5">
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbPage>Skill Packs</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </div>
      </div>
      <div className="container mx-auto px-8 py-10">
        <SkillPackManager />
      </div>
    </div>
  );
}
