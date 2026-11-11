import { prisma } from "../../lib/db/client";
import { E2E } from "./fixtures";

/** Remove everything the e2e tests seeded or created (products with e2e- IDs or "E2E" titles). */
export default async function globalTeardown(): Promise<void> {
  try {
    process.loadEnvFile(".env");
  } catch {
    // CI: DATABASE_URL comes from the environment.
  }
  const products = await prisma.product.findMany({
    where: { OR: [{ id: { startsWith: "e2e-" } }, { title: { startsWith: E2E.titlePrefix } }] },
    select: { id: true },
  });
  const ids = products.map((p) => p.id);
  if (ids.length > 0) {
    const orders = await prisma.order.findMany({ where: { productId: { in: ids } }, select: { id: true } });
    await prisma.auditLog.deleteMany({ where: { orderId: { in: orders.map((o) => o.id) } } });
    await prisma.order.updateMany({ where: { productId: { in: ids } }, data: { previousOrderId: null } });
    await prisma.order.deleteMany({ where: { productId: { in: ids } } });
    await prisma.priceTable.deleteMany({ where: { productId: { in: ids } } });
    await prisma.product.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.$disconnect();
}
