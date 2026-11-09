
import os
import sqlite3
import hashlib
import subprocess


# BUG 1: Division by zero possibility
def calculate_average(total, count):
    return total / count


# BUG 2: Possible null value handling issue
def get_username(user):
    return user["name"].upper()


# VULNERABILITY 1: Hardcoded password
DB_PASSWORD = "Admin@123456"


# VULNERABILITY 2: SQL Injection
def get_user(cursor, username):
    query = "SELECT * FROM users WHERE username = '" + username + "'"
    cursor.execute(query)
    return cursor.fetchall()


# VULNERABILITY 3: Command injection
def execute_command(user_input):
    os.system("echo " + user_input)


# VULNERABILITY 4: Weak hashing algorithm
def hash_password(password):
    return hashlib.md5(password.encode()).hexdigest()


# CODE SMELL 1: Unused variable
def calculate_total(price, quantity):
    discount = 10
    tax = 5
    unused_value = 100

    return price * quantity


# CODE SMELL 2: Duplicate code
def add_numbers(a, b):
    result = a + b
    print(result)
    return result


def sum_values(x, y):
    output = x + y
    print(output)
    return output


# CODE SMELL 3: Too many function arguments
def create_user(name, email, age, address, phone, city, country):
    print(name, email, age, address, phone, city, country)


# CODE SMELL 4: Poor exception handling
def read_file(filename):
    try:
        file = open(filename, "r")
        data = file.read()
        return data
    except:
        pass


# BUG 3: Incorrect comparison
def check_admin(role):
    if role is "admin":
        return True
    return False


# BUG 4: Incorrect logic
def is_even(number):
    if number % 2 == 1:
        return True
    return False


# Main function
def main():
    print("SonarQube testing started")

    print(calculate_average(100, 0))

    print(get_username(None))

    execute_command("Hello SonarQube")

    print(hash_password("password123"))

    print(is_even(10))

    print(check_admin("admin"))


if __name__ == "__main__":
    main()
