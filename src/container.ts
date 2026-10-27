import type { Deps } from "./deps.js";
import { Idempotency } from "./plugins/idempotency.js";
import { AnalyticsService } from "./modules/admin/analytics.js";
import { AuthService } from "./modules/auth/service.js";
import { ConsultationService } from "./modules/consultations/service.js";
import { PrescriptionService } from "./modules/consultations/prescriptions.js";
import { DoctorService } from "./modules/doctors/service.js";
import { PaymentService } from "./modules/payments/service.js";

/** Composition root for services. Constructor injection only — services never import each other's singletons. */
export function buildServices(d: Deps) {
  return {
    auth: new AuthService(d),
    doctors: new DoctorService(d),
    consultations: new ConsultationService(d),
    prescriptions: new PrescriptionService(d),
    payments: new PaymentService(d),
    analytics: new AnalyticsService(d),
    idempotency: new Idempotency(d.db, d.clock),
  };
}
export type Services = ReturnType<typeof buildServices>;
