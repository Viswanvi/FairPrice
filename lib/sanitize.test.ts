import { describe, expect, it } from "vitest";
import { REDACTED, findCountryCodes, getAtPath, sanitize } from "./sanitize";

// Shape modelled on an Orders v2 response; all values invented.
const order = {
  id: "5O190127TN364715T",
  status: "COMPLETED",
  payer: {
    name: { given_name: "Asha", surname: "Rao" },
    email_address: "buyer@example.com",
    payer_id: "QYR5Z8XDVJNXQ",
    phone: { phone_number: { national_number: "9876543210" } },
    address: { address_line_1: "1 MG Road", admin_area_2: "Bengaluru", postal_code: "560001", country_code: "IN" },
  },
  payment_source: {
    paypal: {
      email_address: "buyer@example.com",
      account_id: "QYR5Z8XDVJNXQ",
      name: { given_name: "Asha", surname: "Rao" },
      address: { country_code: "IN" },
    },
  },
  purchase_units: [
    {
      payee: { email_address: "merchant@example.com", merchant_id: "MERCHANT123" },
      shipping: { name: { full_name: "Asha Rao" }, address: { address_line_1: "1 MG Road", country_code: "IN" } },
      payments: { authorizations: [{ id: "0VF52814937998046", amount: { currency_code: "USD", value: "99.00" } }] },
    },
  ],
  links: [{ rel: "self", href: "https://api-m.sandbox.paypal.com/v2/checkout/orders/5O190127TN364715T" }],
};

describe("sanitize", () => {
  const clean = sanitize(order) as typeof order;
  const text = JSON.stringify(clean);

  it("removes names, emails, phones and street addresses", () => {
    for (const secret of ["Asha", "Rao", "buyer@example.com", "merchant@example.com", "9876543210", "MG Road", "Bengaluru", "560001"]) {
      expect(text).not.toContain(secret);
    }
    expect(clean.payer.name).toBe(REDACTED);
  });

  it("keeps country codes and PayPal IDs", () => {
    expect(clean.payer.address.country_code).toBe("IN");
    expect(clean.payment_source.paypal.address.country_code).toBe("IN");
    expect(clean.payer.payer_id).toBe("QYR5Z8XDVJNXQ");
    expect(clean.purchase_units[0].payments.authorizations[0].id).toBe("0VF52814937998046");
    expect(clean.links[0].href).toContain("5O190127TN364715T");
  });

  it("keeps string error names such as UNPROCESSABLE_ENTITY", () => {
    expect(sanitize({ name: "UNPROCESSABLE_ENTITY", debug_id: "abc123" })).toEqual({
      name: "UNPROCESSABLE_ENTITY",
      debug_id: "abc123",
    });
  });

  it("redacts emails embedded in free text", () => {
    expect(sanitize({ message: "Payer buyer@example.com declined" })).toEqual({
      message: "Payer [redacted-email] declined",
    });
  });

  it("removes tokens", () => {
    expect(sanitize({ access_token: "A21AAF", expires_in: 32400 })).toEqual({
      access_token: REDACTED,
      expires_in: 32400,
    });
  });
});

describe("findCountryCodes", () => {
  it("lists every country_code with its full path", () => {
    expect(findCountryCodes(order)).toEqual([
      { path: "payer.address.country_code", value: "IN" },
      { path: "payment_source.paypal.address.country_code", value: "IN" },
      { path: "purchase_units[0].shipping.address.country_code", value: "IN" },
    ]);
  });

  it("returns an empty list when there are none", () => {
    expect(findCountryCodes({ id: "X", status: "CREATED" })).toEqual([]);
  });
});

describe("getAtPath", () => {
  it("reads nested object and array paths", () => {
    expect(getAtPath(order, "payer.address.country_code")).toBe("IN");
    expect(getAtPath(order, "purchase_units[0].payments.authorizations[0].amount.value")).toBe("99.00");
  });

  it("returns undefined for a missing path", () => {
    expect(getAtPath(order, "payer.address.region")).toBeUndefined();
    expect(getAtPath(order, "purchase_units[3].payments")).toBeUndefined();
    expect(getAtPath(null, "a.b")).toBeUndefined();
  });
});
