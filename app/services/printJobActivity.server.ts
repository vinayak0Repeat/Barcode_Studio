export interface PrintActivityRepo {
  activity: {
    create(args: { data: {
      shopId: string;
      type: "printed";
      staffId: string | null;
      productCount: number;
      labelCount: number;
      jobId: string;
    } }): Promise<unknown>;
  };
}

/** The single creation-time Activity write for a print job. */
export function createPrintedActivity(
  repo: PrintActivityRepo,
  data: Omit<Parameters<PrintActivityRepo["activity"]["create"]>[0]["data"], "type">,
) {
  return repo.activity.create({ data: { ...data, type: "printed" } });
}
