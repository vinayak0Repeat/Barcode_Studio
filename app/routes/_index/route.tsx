import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect, Form, useActionData, useLoaderData } from "react-router";

import { login } from "../../shopify.server";
import { loginErrorMessage } from "./error.server";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const errors = loginErrorMessage(await login(request));

  return { errors };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const errors = actionData?.errors;

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <span className={styles.eyebrow}>Barcode Studio</span>
        <h1 className={styles.heading}>Open your store workspace</h1>
        <p className={styles.text}>
          This page appears when Barcode Studio opens without Shopify store context. Open the app from Shopify Admin, or enter your store domain below to reconnect.
        </p>
        {showForm && (
          <Form className={styles.form} method="post">
            <label className={styles.label}>
              <span>Shopify store domain</span>
              <input className={styles.input} type="text" name="shop" placeholder="your-store.myshopify.com" autoComplete="url" />
              <span className={errors?.shop ? styles.error : styles.hint}>{errors?.shop ?? "Enter your .myshopify.com domain."}</span>
            </label>
            <button className={styles.button} type="submit">
              Reconnect store
            </button>
          </Form>
        )}
      </div>
    </div>
  );
}
